// ============================================================================
// Unified Live TV — Phase 3 EPG refresh service (server-only orchestration).
//
//   trigger → eligibility gates → guarded fetch (shared fetcher) → content-
//   detected decompression → bounded parse → pure mapping plan → pure
//   ingestion plan → bounded persistence → bounded retention → outcome
//
// RELIABILITY CONTRACT (Phase 3 brief §9; mirrors the Phase 2 refresh
// service exactly):
//   * Eligibility — the guide source must be enabled with an eligible
//     status (Phase 1 rule S1/S2 vocabulary); disabled/unavailable sources
//     are never refreshed.
//   * Duplicate-refresh prevention — a per-instance in-flight map keyed by
//     EPG source id returns a typed `refresh_in_progress` outcome (the same
//     serverless-honesty disclosure as Phase 2).
//   * Bounded duration — an overall deadline (AbortController) is linked
//     into the fetch AND the parser; parse caps bound the rest.
//   * Failure taxonomy — fetch failure, decompression abuse, invalid
//     payload/structure, per-record skips and per-batch DB write errors are
//     DISTINCT typed outcomes with static, diagnostics-safe messages (no
//     URLs with query strings, no credentials, no raw XML).
//   * No accidental state changes — a refresh NEVER mutates the EPG source
//     row (enabled/status), NEVER touches channels, source entries,
//     mappings, playback endpoints or candidates, and NEVER enables the
//     unified system. One failed refresh never marks the source
//     unavailable and never erases the last good guide.
//   * State reporting — outcomes are REPORTED (return value + a bounded
//     per-instance record consumed by the admin status API), mirroring the
//     Phase 2 report-only contract. Persistent refresh history remains the
//     separately-proposed schema idea (Phase 2 P2-8 / Phase 4 review) and
//     is deliberately NOT implemented here.
//   * No scheduler — manual/server-triggered refresh only (Phase 7 owns
//     scheduling).
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../supabase/database.types';
import { LIVETV_PLAYBACK_ELIGIBLE_STATUSES, type LivetvSourceStatus } from '../registry';
import type { SafeDnsResolver } from '../../streaming/stremio/ssrf';
import { LivetvSourceFetchError, fetchLivetvSourceBytes } from '../fetch-safe';
import { assertValidIanaTimezone } from './time';
import { XMLTV_MAX_COMPRESSED_BYTES, XmltvDocumentError, decodeXmltvPayload, parseXmltvDocument, type XmltvDiagnostics, type XmltvParseLimits } from './xmltv';
import { planEpgMapping, type EpgMappingRow, type EpgSourceChannelRow } from './mapping';
import { applyGuideIngestion, planGuideIngestion, type EpgExecutionError, type ExistingEpgProgrammeRow } from './ingestion';
import { applyEpgRetention } from './retention';
import { livetvHistoryRowFromEpgOutcome, recordLivetvRefreshHistory, type LivetvHistoryTrigger } from '../history';

/** Bounded defaults for one guide refresh (guides are larger than playlists). */
export const EPG_REFRESH_TIMEOUT_MS = 60_000;
export const EPG_REFRESH_MAX_SOURCES_PER_RUN = 10;
/**
 * Phase 7 — bounded mapping read: the tvgId/mapping plan reads at most this
 * many source-channel rows per refresh (the mapping diagnostics probe cap
 * parity; beyond the cap the outcome honestly reports `entriesTruncated`).
 */
export const EPG_REFRESH_MAX_SOURCE_CHANNELS = 5_000;
/** Bound on stored diagnostics samples in an outcome. */
const OUTCOME_SAMPLE = 100;

/** Decompressed/parse budgets (XmltvParseLimits parity, documented). */
const EPG_PARSE_LIMITS: Partial<XmltvParseLimits> = {};

// ---------------------------------------------------------------------------
// Config validation (the `livetv_epg_sources.config` jsonb contract)
// ---------------------------------------------------------------------------

/** The typed EPG source config: an optional default IANA timezone + (Phase 7) an optional refresh interval. */
export type LivetvEpgSourceConfig = {
        /**
         * Interprets TIMEZONE-LESS XMLTV timestamps (documented policy —
         * they are never read in the server's local timezone). Absent ⇒
         * timezone-less timestamps are per-record skips.
         */
        defaultTimezone?: string;
        /**
         * Phase 7 — optional per-source refresh interval for the scheduler
         * (minutes; 15..10080). Absent ⇒ the scheduler default applies.
         */
        refreshIntervalMinutes?: number;
};

export function validateEpgSourceConfig(raw: unknown): LivetvEpgSourceConfig {
        if (raw === null || raw === undefined) return {};
        if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('EPG source config must be a JSON object.');
        const config = raw as Record<string, unknown>;
        for (const key of Object.keys(config)) {
                if (key !== 'defaultTimezone' && key !== 'refreshIntervalMinutes') throw new Error(`EPG source config: unknown config key "${key.slice(0, 40)}".`);
        }
        const result: LivetvEpgSourceConfig = {};
        if (config.defaultTimezone === undefined) {
                // absent — no timezone policy override
        } else if (typeof config.defaultTimezone !== 'string') {
                throw new Error('EPG source config: "defaultTimezone" must be a string.');
        } else {
                try {
                        result.defaultTimezone = assertValidIanaTimezone(config.defaultTimezone);
                } catch (error) {
                        throw new Error(error instanceof Error ? error.message.slice(0, 200) : 'EPG source config: invalid defaultTimezone.');
                }
        }
        if (config.refreshIntervalMinutes !== undefined) {
                const raw = config.refreshIntervalMinutes;
                if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) throw new Error('EPG source config: "refreshIntervalMinutes" must be an integer number of minutes.');
                if (raw < 15 || raw > 10_080) throw new Error('EPG source config: "refreshIntervalMinutes" must be between 15 and 10080 minutes.');
                result.refreshIntervalMinutes = raw;
        }
        return result;
}

// ---------------------------------------------------------------------------
// Outcome types (the refresh report)
// ---------------------------------------------------------------------------

export type LivetvEpgRefreshFailureKind =
        | 'lookup_failed'
        | 'epg_source_not_found'
        | 'epg_source_ineligible'
        | 'invalid_source_config'
        | 'invalid_url'
        | 'blocked_url'
        | 'timeout'
        | 'too_large'
        | 'http_error'
        | 'network'
        | 'unsupported_media_type'
        | 'empty_document'
        | 'invalid_gzip'
        | 'decompression_too_large'
        | 'unsupported_encoding'
        | 'structure_invalid'
        | 'channel_cap_exceeded'
        | 'programme_cap_exceeded'
        | 'nesting_too_deep'
        | 'parse_deadline_exceeded'
        | 'cancelled'
        | 'refresh_in_progress'
        | 'unexpected';

const FETCH_KIND_TO_EPG_KIND: Record<string, LivetvEpgRefreshFailureKind> = {
        invalid_url: 'invalid_url',
        blocked_url: 'blocked_url',
        timeout: 'timeout',
        too_large: 'too_large',
        http_error: 'http_error',
        network: 'network',
        unsupported_media_type: 'unsupported_media_type',
        invalid_payload: 'unexpected',
        cancelled: 'cancelled',
        unexpected: 'unexpected'
};

const DOCUMENT_KIND_TO_EPG_KIND: Record<string, LivetvEpgRefreshFailureKind> = {
        empty_document: 'empty_document',
        invalid_gzip: 'invalid_gzip',
        decompression_too_large: 'decompression_too_large',
        unsupported_encoding: 'unsupported_encoding',
        structure_invalid: 'structure_invalid',
        channel_cap_exceeded: 'channel_cap_exceeded',
        programme_cap_exceeded: 'programme_cap_exceeded',
        nesting_too_deep: 'nesting_too_deep',
        parse_deadline_exceeded: 'parse_deadline_exceeded',
        cancelled: 'cancelled',
        unexpected: 'unexpected'
};

export type LivetvEpgRefreshCounts = {
        /** Channel + programme records the parser discovered. */
        guideChannels: number;
        programmesDiscovered: number;
        channelsSkipped: number;
        programmesSkipped: number;
        /** Persistence counts (honest: inserted/updated/unchanged/skipped/failed). */
        programmesInserted: number;
        programmesUpdated: number;
        programmesUnchanged: number;
        programmesSkippedInvalid: number;
        programmesFailed: number;
        /** Report-only stale diagnostics (never mutated, never deleted by the refresh). */
        programmesMissingUpstream: number;
        /** Mapping diagnostics. */
        channelsMatched: number;
        channelsMatchedExplicit: number;
        channelsMatchedTvgId: number;
        channelsUnmatched: number;
        channelsAmbiguous: number;
        channelsInvalidId: number;
        /** Retention sweep result (best-effort, post-persistence). */
        retentionDeleted: number | null;
};

export type LivetvEpgRefreshOutcome = {
        epgSourceId: string;
        slug: string;
        epgType: string;
        startedAt: string;
        finishedAt: string;
        durationMs: number;
        ok: boolean;
        /** Typed, diagnostics-safe failure (static message; never a raw URL/XML). */
        failure: { kind: LivetvEpgRefreshFailureKind; message: string } | null;
        counts: LivetvEpgRefreshCounts | null;
        /** Bounded per-record parse samples (static safe reasons). */
        parseSamples: XmltvDiagnostics['samples'] | null;
        /** Bounded per-batch DB write failure sample. */
        executionErrors: Pick<EpgExecutionError, 'scope' | 'epgChannelId' | 'message'>[] | null;
        /** Skipped-record reason histogram (safe static reasons). */
        skipReasons: Record<string, number> | null;
        /** Bounded mapping diagnostic samples (guide ids only — never URLs). */
        mappingSamples: { unmatched: string[]; ambiguous: string[]; invalid: string[] } | null;
        /** Timezone policy actually applied (diagnostics). */
        timezonePolicy: { configured: string | null; explicitOffsetTimestamps: number; defaultTimezoneTimestamps: number } | null;
        /** Phase 7 — who asked for this refresh (scheduler or a manual admin action). */
        trigger: LivetvHistoryTrigger;
        /** Phase 7 — true when the bounded mapping read hit its honest cap. */
        entriesTruncated: boolean;
        /** Phase 7 — whether the best-effort persistent-history write landed. */
        historyPersisted: boolean | null;
};

function nowIso(): string {
        return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Bounded in-memory outcome record (per-instance; serverless honesty applies)
// ---------------------------------------------------------------------------

const MAX_RECORDED_OUTCOMES = 200;
const lastOutcomes = new Map<string, LivetvEpgRefreshOutcome>();

/** Test seam — clears the outcome record and the in-flight map. */
export function resetLivetvEpgStateForTests(): void {
        lastOutcomes.clear();
        inFlight.clear();
}

/** Last recorded outcome per refreshed EPG source (most recent first, bounded). */
export function getLivetvEpgRefreshOutcomes(): LivetvEpgRefreshOutcome[] {
        return [...lastOutcomes.values()].sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1));
}

function recordOutcome(outcome: LivetvEpgRefreshOutcome): void {
        if (lastOutcomes.size >= MAX_RECORDED_OUTCOMES && !lastOutcomes.has(outcome.epgSourceId)) {
                for (const key of lastOutcomes.keys()) {
                        lastOutcomes.delete(key);
                        break;
                }
        }
        lastOutcomes.set(outcome.epgSourceId, outcome);
}

// ---------------------------------------------------------------------------
// Duplicate-refresh prevention (per-instance)
// ---------------------------------------------------------------------------

const inFlight = new Map<string, Promise<LivetvEpgRefreshOutcome>>();

/** Phase 7 — instance-local in-flight count (ops diagnostics; serverless-honest). */
export function getLivetvEpgInFlightCount(): number {
        return inFlight.size;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type EpgSourceRow = {
        id: string;
        slug: string;
        epg_type: string;
        enabled: boolean;
        status: string;
        config: unknown;
        source_url: string | null;
};

async function loadEpgSourceRow(client: SupabaseClient<Database>, ref: { id?: string; slug?: string }): Promise<{ row: EpgSourceRow | null; error: boolean }> {
        let query = client.from('livetv_epg_sources').select('id, slug, epg_type, enabled, status, config, source_url').limit(1);
        query = ref.id ? query.eq('id', ref.id) : query.eq('slug', ref.slug ?? '');
        const { data, error } = await query.maybeSingle();
        if (error) return { row: null, error: true };
        return { row: (data as EpgSourceRow | null) ?? null, error: false };
}

function linkDeadline(deps: LivetvEpgRefreshDeps, deadlineMs: number): { signal: AbortSignal; dispose: () => void } {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), deadlineMs);
        const external = deps.signal;
        if (external) {
                if (external.aborted) controller.abort();
                const onAbort = () => controller.abort();
                external.addEventListener('abort', onAbort, { once: true });
                return {
                        signal: controller.signal,
                        dispose: () => {
                                clearTimeout(timer);
                                external.removeEventListener('abort', onAbort);
                        }
                };
        }
        return {
                signal: controller.signal,
                dispose: () => clearTimeout(timer)
        };
}

function failureOutcome(started: { at: string; ms: number }, row: { id: string; slug: string; epg_type: string } | null, kind: LivetvEpgRefreshFailureKind, message: string, trigger: LivetvHistoryTrigger = 'manual'): LivetvEpgRefreshOutcome {
        return {
                epgSourceId: row?.id ?? 'unknown',
                slug: row?.slug ?? 'unknown',
                epgType: row?.epg_type ?? 'unknown',
                startedAt: started.at,
                finishedAt: nowIso(),
                durationMs: Date.now() - started.ms,
                ok: false,
                failure: { kind, message },
                counts: null,
                parseSamples: null,
                executionErrors: null,
                skipReasons: null,
                mappingSamples: null,
                timezonePolicy: null,
                trigger,
                entriesTruncated: false,
                historyPersisted: null
        };
}

// ---------------------------------------------------------------------------
// Refresh deps
// ---------------------------------------------------------------------------

export type LivetvEpgRefreshDeps = {
        fetcher?: typeof fetch;
        dnsResolver?: SafeDnsResolver;
        /** Overall deadline for the whole refresh (default 60s). */
        refreshTimeoutMs?: number;
        /** Per-fetch timeout budget (default: the shared fetcher's 12s). */
        timeoutMs?: number;
        /** Compressed byte budget (default: the XMLTV compressed cap). */
        maxBytes?: number;
        maxRedirects?: number;
        /** Parse budget overrides (documented policy defaults otherwise). */
        parseLimits?: Partial<XmltvParseLimits>;
        /** External cancellation linked into the refresh deadline. */
        signal?: AbortSignal;
        /** Retention sweep override (tests); default ON after successful persistence. */
        retention?: boolean;
        /** Phase 7 — who triggered this refresh (drives persistent history; default 'manual'). */
        trigger?: LivetvHistoryTrigger;
        /** Phase 7 — correlation id grouping the attempts of ONE logical operation. */
        correlationId?: string;
        /** Phase 7 — 1-based attempt number within the correlation (default 1). */
        attemptNumber?: number;
};

// ---------------------------------------------------------------------------
// Single-source refresh
// ---------------------------------------------------------------------------

/**
 * Refreshes ONE EPG source by id or slug. Never throws — every failure
 * becomes a typed outcome. A concurrent second call for the same source
 * returns a typed `refresh_in_progress` outcome instead of double-fetching.
 *
 * Phase 7: the source row is resolved FIRST so the in-flight guard is keyed
 * by the canonical EPG source id (id/slug dedup fix), and every resolved
 * attempt is appended to the persistent history best-effort (a history
 * failure NEVER fails the refresh).
 */
export async function refreshLivetvEpgSource(client: SupabaseClient<Database>, ref: { id?: string; slug?: string }, deps: LivetvEpgRefreshDeps = {}): Promise<LivetvEpgRefreshOutcome> {
        const started = { at: nowIso(), ms: Date.now() };
        const trigger = deps.trigger ?? 'manual';

        const loaded = await loadEpgSourceRow(client, ref);
        if (loaded.error) return failureOutcome(started, null, 'lookup_failed', 'The guide source lookup failed.', trigger);
        if (!loaded.row) return failureOutcome(started, null, 'epg_source_not_found', 'The requested guide source does not exist.', trigger);
        const row = loaded.row;

        const pending = inFlight.get(row.id);
        if (pending) {
                const duplicate = failureOutcome(started, row, 'refresh_in_progress', 'A guide refresh for this source is already in progress.', trigger);
                duplicate.historyPersisted = await recordLivetvRefreshHistory(
                        client,
                        livetvHistoryRowFromEpgOutcome(duplicate, { trigger, correlationId: deps.correlationId ?? crypto.randomUUID(), attemptNumber: deps.attemptNumber ?? 1 })
                );
                return duplicate;
        }

        const run = runEpgRefreshForSourceRow(client, started, row, deps).finally(() => {
                inFlight.delete(row.id);
        });
        // Registered synchronously in the same tick as the check above.
        inFlight.set(row.id, run);
        const outcome = await run;
        recordOutcome(outcome);
        outcome.historyPersisted = await recordLivetvRefreshHistory(
                client,
                livetvHistoryRowFromEpgOutcome(outcome, { trigger, correlationId: deps.correlationId ?? crypto.randomUUID(), attemptNumber: deps.attemptNumber ?? 1 })
        );
        return outcome;
}

/** The guide refresh pipeline AFTER the row is resolved. */
async function runEpgRefreshForSourceRow(client: SupabaseClient<Database>, started: { at: string; ms: number }, row: EpgSourceRow, deps: LivetvEpgRefreshDeps): Promise<LivetvEpgRefreshOutcome> {
        const trigger = deps.trigger ?? 'manual';

        // --- eligibility (Phase 1 rule S1/S2 parity) ---
        if (!row.enabled || !LIVETV_PLAYBACK_ELIGIBLE_STATUSES.has(row.status as LivetvSourceStatus)) {
                return failureOutcome(started, row, 'epg_source_ineligible', 'The guide source is not eligible for refresh (disabled or non-eligible status).', trigger);
        }

        // --- config validation ---
        let config: LivetvEpgSourceConfig;
        try {
                config = validateEpgSourceConfig(row.config);
        } catch (error) {
                return failureOutcome(started, row, 'invalid_source_config', error instanceof Error ? error.message : 'The guide source config is invalid.', trigger);
        }

        // --- URL policy re-assertion (the DB CHECK is the primary gate) ---
        const sourceUrl = row.source_url;
        if (!sourceUrl || !sourceUrl.startsWith('https://')) {
                return failureOutcome(started, row, 'invalid_url', 'The guide source has no https URL configured.', trigger);
        }

        // --- guarded fetch (the ONE shared bounded fetcher; brief §11) ---
        const deadline = linkDeadline(deps, deps.refreshTimeoutMs ?? EPG_REFRESH_TIMEOUT_MS);
        let bytes: Uint8Array;
        try {
                const fetched = await fetchLivetvSourceBytes(sourceUrl, {
                        fetcher: deps.fetcher,
                        dnsResolver: deps.dnsResolver,
                        timeoutMs: deps.timeoutMs,
                        maxBytes: deps.maxBytes ?? XMLTV_MAX_COMPRESSED_BYTES,
                        maxRedirects: deps.maxRedirects,
                        signal: deadline.signal
                });
                bytes = fetched.bytes;
        } catch (error) {
                deadline.dispose();
                if (error instanceof LivetvSourceFetchError) {
                        const kind = FETCH_KIND_TO_EPG_KIND[error.kind] ?? 'unexpected';
                        return failureOutcome(started, row, kind, error.message, trigger);
                }
                return failureOutcome(started, row, 'unexpected', 'The guide fetch failed unexpectedly.', trigger);
        }

        // --- content-detected decompression + encoding policy ---
        let xml: string;
        try {
                xml = decodeXmltvPayload(bytes, { ...(deps.parseLimits ?? {}), ...EPG_PARSE_LIMITS });
        } catch (error) {
                deadline.dispose();
                if (error instanceof XmltvDocumentError) {
                        const kind = DOCUMENT_KIND_TO_EPG_KIND[error.kind] ?? 'unexpected';
                        return failureOutcome(started, row, kind, error.message, trigger);
                }
                return failureOutcome(started, row, 'unexpected', 'The guide document could not be decoded.', trigger);
        }

        // --- bounded parse (deadline signal + caps + per-record isolation) ---
        let parsed;
        try {
                parsed = parseXmltvDocument(xml, {
                        defaultTimezone: config.defaultTimezone ?? null,
                        limits: { ...(deps.parseLimits ?? {}), ...EPG_PARSE_LIMITS },
                        signal: deadline.signal
                });
        } catch (error) {
                deadline.dispose();
                if (error instanceof XmltvDocumentError) {
                        const kind = DOCUMENT_KIND_TO_EPG_KIND[error.kind] ?? 'unexpected';
                        return failureOutcome(started, row, kind, error.message, trigger);
                }
                return failureOutcome(started, row, 'unexpected', 'The guide document could not be parsed.', trigger);
        }
        // NOTE (Phase 7): the deadline signal stays linked through the
        // ingestion phase below — an abandoned caller must be able to stop
        // batched DB writes. dispose() moves to after persistence.

        // --- mapping plan (pure; explicit rows + tvgId votes) ---
        const mappingsResult = await client.from('livetv_epg_channel_mappings').select('epg_channel_id, channel_id').eq('epg_source_id', row.id);
        if (mappingsResult.error) {
                deadline.dispose();
                return failureOutcome(started, row, 'lookup_failed', 'The guide mapping lookup failed.', trigger);
        }
        const explicitMappings = (mappingsResult.data ?? []) as unknown as EpgMappingRow[];

        // Phase 7: the mapping read is bounded — beyond the cap the tvgId
        // vote pool would silently change shape, so the outcome reports
        // `entriesTruncated` honestly instead.
        const entriesResult = await client.from('livetv_source_channels').select('id, source_id, source_channel_id, canonical_channel_id, tvg_id, enabled').limit(EPG_REFRESH_MAX_SOURCE_CHANNELS);
        if (entriesResult.error) {
                deadline.dispose();
                return failureOutcome(started, row, 'lookup_failed', 'The source channel lookup failed.', trigger);
        }
        const sourceChannels = (entriesResult.data ?? []) as unknown as EpgSourceChannelRow[];
        const entriesTruncated = sourceChannels.length >= EPG_REFRESH_MAX_SOURCE_CHANNELS;

        const mappingPlan = planEpgMapping({
                // Every DISTINCT guide identity the document revealed: declared
                // channels, programme references (a guide may reference an id
                // without declaring it) and rejected id samples.
                guideChannelIds: [...new Set([...parsed.channels.map((channel) => channel.id), ...parsed.programmes.map((programme) => programme.channelId), ...parsed.diagnostics.invalidChannelIdSamples])],
                explicitMappings,
                sourceChannels
        });

        // --- ingestion plan (pure) over the bounded existing window ---
        const plan = planGuideIngestion({ epgSourceId: row.id, programmes: parsed.programmes, existingRows: [] });
        let existingRows: ExistingEpgProgrammeRow[] = [];
        if (plan.window) {
                const existingResult = await client
                        .from('livetv_epg_programmes')
                        .select('id, epg_source_id, epg_channel_id, start_at, end_at, title, sub_title, description, category, icon_url, language')
                        .eq('epg_source_id', row.id)
                        .gte('start_at', new Date(plan.window.startMs).toISOString())
                        .lte('start_at', new Date(plan.window.endMs).toISOString());
                if (existingResult.error) {
                        deadline.dispose();
                        return failureOutcome(started, row, 'lookup_failed', 'The existing guide lookup failed.', trigger);
                }
                existingRows = ((existingResult.data ?? []) as unknown as (Omit<ExistingEpgProgrammeRow, 'startMs' | 'endMs'> & { start_at: string; end_at: string })[]).map((row) => ({
                        ...row,
                        startMs: Date.parse(row.start_at),
                        endMs: Date.parse(row.end_at)
                }));
        }
        const finalPlan = planGuideIngestion({ epgSourceId: row.id, programmes: parsed.programmes, existingRows });

        // --- bounded persistence (unchanged rows never written; the deadline
        // signal stops batched mutations once the caller has abandoned the run) ---
        const execution = await applyGuideIngestion(client, finalPlan, { signal: deadline.signal });
        deadline.dispose();

        // --- bounded retention sweep (best-effort, post-persistence) ---
        let retentionDeleted: number | null = null;
        if (deps.retention !== false) {
                try {
                        const retention = await applyEpgRetention(client, { epgSourceId: row.id });
                        retentionDeleted = retention.deleted;
                } catch {
                        // Retention is never a refresh failure; the next sweep converges.
                        retentionDeleted = null;
                }
        }

        const counts: LivetvEpgRefreshCounts = {
                guideChannels: mappingPlan.counts.guideChannels,
                programmesDiscovered: parsed.diagnostics.programmesDiscovered,
                channelsSkipped: parsed.diagnostics.channelsSkipped,
                programmesSkipped: parsed.diagnostics.programmesSkipped,
                programmesInserted: finalPlan.counts.inserted,
                programmesUpdated: finalPlan.counts.updated,
                programmesUnchanged: finalPlan.counts.unchanged,
                programmesSkippedInvalid: finalPlan.counts.skipped,
                programmesFailed: execution.errors.length,
                programmesMissingUpstream: finalPlan.programmesMissingUpstream,
                channelsMatched: mappingPlan.counts.matched,
                channelsMatchedExplicit: mappingPlan.counts.viaExplicit,
                channelsMatchedTvgId: mappingPlan.counts.viaTvgId,
                channelsUnmatched: mappingPlan.counts.unmatched,
                channelsAmbiguous: mappingPlan.counts.ambiguous,
                channelsInvalidId: mappingPlan.counts.invalid,
                retentionDeleted
        };

        return {
                epgSourceId: row.id,
                slug: row.slug,
                epgType: row.epg_type,
                startedAt: started.at,
                finishedAt: nowIso(),
                durationMs: Date.now() - started.ms,
                ok: true,
                failure: null,
                counts,
                parseSamples: parsed.diagnostics.samples.slice(0, OUTCOME_SAMPLE),
                executionErrors: execution.errors.slice(0, OUTCOME_SAMPLE),
                skipReasons: parsed.diagnostics.skipReasons,
                mappingSamples: mappingPlan.samples,
                timezonePolicy: {
                        configured: config.defaultTimezone ?? null,
                        explicitOffsetTimestamps: parsed.counts.explicitOffsetTimestamps,
                        defaultTimezoneTimestamps: parsed.counts.defaultTimezoneTimestamps
                },
                trigger,
                entriesTruncated,
                historyPersisted: null
        };
}

// ---------------------------------------------------------------------------
// Multi-source refresh (per-source isolation)
// ---------------------------------------------------------------------------

export type LivetvEpgRefreshAllOutcome = {
        startedAt: string;
        finishedAt: string;
        durationMs: number;
        eligibleSources: number;
        refreshedSources: number;
        outcomes: LivetvEpgRefreshOutcome[];
};

/**
 * Refreshes every ELIGIBLE EPG source (enabled + eligible status), sequentially
 * and per-source isolated. One failing source never prevents the others. Bounded.
 */
export async function refreshAllEligibleLivetvEpgSources(client: SupabaseClient<Database>, deps: LivetvEpgRefreshDeps = {}): Promise<LivetvEpgRefreshAllOutcome> {
        const started = { at: nowIso(), ms: Date.now() };
        const { data, error } = await client.from('livetv_epg_sources').select('id, slug, epg_type, enabled, status').order('slug', { ascending: true });
        if (error) {
                return { startedAt: started.at, finishedAt: nowIso(), durationMs: Date.now() - started.ms, eligibleSources: 0, refreshedSources: 0, outcomes: [] };
        }
        const rows = (data ?? []) as unknown as { id: string; slug: string; epg_type: string; enabled: boolean; status: string }[];
        const eligible = rows.filter((row) => row.enabled && LIVETV_PLAYBACK_ELIGIBLE_STATUSES.has(row.status as LivetvSourceStatus));

        const outcomes: LivetvEpgRefreshOutcome[] = [];
        const bounded = eligible.slice(0, EPG_REFRESH_MAX_SOURCES_PER_RUN);
        for (const row of bounded) {
                try {
                        outcomes.push(await refreshLivetvEpgSource(client, { id: row.id }, deps));
                } catch {
                        outcomes.push(failureOutcome(started, row, 'unexpected', 'The guide refresh failed unexpectedly.'));
                }
        }
        return { startedAt: started.at, finishedAt: nowIso(), durationMs: Date.now() - started.ms, eligibleSources: eligible.length, refreshedSources: bounded.length, outcomes };
}

// ---------------------------------------------------------------------------
// Dry-run preview (fetch + decode + parse + map + plan; NO writes)
// ---------------------------------------------------------------------------

export type LivetvEpgPreviewOutcome = {
        ok: boolean;
        failure: { kind: LivetvEpgRefreshFailureKind; message: string } | null;
        /** Plan counts (what a real refresh WOULD write). */
        counts: LivetvEpgRefreshCounts | null;
        parseSamples: XmltvDiagnostics['samples'] | null;
        skipReasons: Record<string, number> | null;
        mappingSamples: { unmatched: string[]; ambiguous: string[]; invalid: string[] } | null;
        timezonePolicy: { configured: string | null; explicitOffsetTimestamps: number; defaultTimezoneTimestamps: number } | null;
};

/**
 * Validates + fetches + decodes + parses + maps + plans a guide source
 * WITHOUT persisting anything — the safe testing/validation surface.
 * Never throws. The response carries counts and static samples only —
 * never an upstream URL, never raw XML.
 */
export async function previewLivetvEpgSource(client: SupabaseClient<Database>, ref: { id?: string; slug?: string }, deps: LivetvEpgRefreshDeps = {}): Promise<LivetvEpgPreviewOutcome> {
        const loaded = await loadEpgSourceRow(client, ref);
        if (loaded.error) return epgPreviewFailure('lookup_failed', 'The guide source lookup failed.');
        if (!loaded.row) return epgPreviewFailure('epg_source_not_found', 'The requested guide source does not exist.');
        const row = loaded.row;
        if (!row.enabled || !LIVETV_PLAYBACK_ELIGIBLE_STATUSES.has(row.status as LivetvSourceStatus)) {
                return epgPreviewFailure('epg_source_ineligible', 'The guide source is not eligible (disabled or non-eligible status).');
        }
        let config: LivetvEpgSourceConfig;
        try {
                config = validateEpgSourceConfig(row.config);
        } catch (error) {
                return epgPreviewFailure('invalid_source_config', error instanceof Error ? error.message : 'The guide source config is invalid.');
        }
        const sourceUrl = row.source_url;
        if (!sourceUrl || !sourceUrl.startsWith('https://')) {
                return epgPreviewFailure('invalid_url', 'The guide source has no https URL configured.');
        }

        const deadline = linkDeadline(deps, deps.refreshTimeoutMs ?? EPG_REFRESH_TIMEOUT_MS);
        let bytes: Uint8Array;
        try {
                const fetched = await fetchLivetvSourceBytes(sourceUrl, {
                        fetcher: deps.fetcher,
                        dnsResolver: deps.dnsResolver,
                        timeoutMs: deps.timeoutMs,
                        maxBytes: deps.maxBytes ?? XMLTV_MAX_COMPRESSED_BYTES,
                        maxRedirects: deps.maxRedirects,
                        signal: deadline.signal
                });
                bytes = fetched.bytes;
        } catch (error) {
                deadline.dispose();
                if (error instanceof LivetvSourceFetchError) {
                        return epgPreviewFailure(FETCH_KIND_TO_EPG_KIND[error.kind] ?? 'unexpected', error.message);
                }
                return epgPreviewFailure('unexpected', 'The guide fetch failed unexpectedly.');
        }

        let xml: string;
        try {
                xml = decodeXmltvPayload(bytes, { ...(deps.parseLimits ?? {}), ...EPG_PARSE_LIMITS });
        } catch (error) {
                deadline.dispose();
                if (error instanceof XmltvDocumentError) {
                        return epgPreviewFailure(DOCUMENT_KIND_TO_EPG_KIND[error.kind] ?? 'unexpected', error.message);
                }
                return epgPreviewFailure('unexpected', 'The guide document could not be decoded.');
        }

        let parsed;
        try {
                parsed = parseXmltvDocument(xml, {
                        defaultTimezone: config.defaultTimezone ?? null,
                        limits: { ...(deps.parseLimits ?? {}), ...EPG_PARSE_LIMITS },
                        signal: deadline.signal
                });
        } catch (error) {
                deadline.dispose();
                if (error instanceof XmltvDocumentError) {
                        return epgPreviewFailure(DOCUMENT_KIND_TO_EPG_KIND[error.kind] ?? 'unexpected', error.message);
                }
                return epgPreviewFailure('unexpected', 'The guide document could not be parsed.');
        }
        deadline.dispose();

        const mappingsResult = await client.from('livetv_epg_channel_mappings').select('epg_channel_id, channel_id').eq('epg_source_id', row.id);
        if (mappingsResult.error) return epgPreviewFailure('lookup_failed', 'The guide mapping lookup failed.');
        const explicitMappings = (mappingsResult.data ?? []) as unknown as EpgMappingRow[];
        const entriesResult = await client.from('livetv_source_channels').select('id, source_id, source_channel_id, canonical_channel_id, tvg_id, enabled');
        if (entriesResult.error) return epgPreviewFailure('lookup_failed', 'The source channel lookup failed.');
        const sourceChannels = (entriesResult.data ?? []) as unknown as EpgSourceChannelRow[];

        const mappingPlan = planEpgMapping({
                guideChannelIds: [...new Set([...parsed.channels.map((channel) => channel.id), ...parsed.programmes.map((programme) => programme.channelId), ...parsed.diagnostics.invalidChannelIdSamples])],
                explicitMappings,
                sourceChannels
        });
        const plan = planGuideIngestion({ epgSourceId: row.id, programmes: parsed.programmes, existingRows: [] });

        return {
                ok: true,
                failure: null,
                counts: {
                        guideChannels: mappingPlan.counts.guideChannels,
                        programmesDiscovered: parsed.diagnostics.programmesDiscovered,
                        channelsSkipped: parsed.diagnostics.channelsSkipped,
                        programmesSkipped: parsed.diagnostics.programmesSkipped,
                        programmesInserted: plan.counts.inserted,
                        programmesUpdated: plan.counts.updated,
                        programmesUnchanged: plan.counts.unchanged,
                        programmesSkippedInvalid: plan.counts.skipped,
                        programmesFailed: 0,
                        programmesMissingUpstream: 0,
                        channelsMatched: mappingPlan.counts.matched,
                        channelsMatchedExplicit: mappingPlan.counts.viaExplicit,
                        channelsMatchedTvgId: mappingPlan.counts.viaTvgId,
                        channelsUnmatched: mappingPlan.counts.unmatched,
                        channelsAmbiguous: mappingPlan.counts.ambiguous,
                        channelsInvalidId: mappingPlan.counts.invalid,
                        retentionDeleted: null
                },
                parseSamples: parsed.diagnostics.samples.slice(0, OUTCOME_SAMPLE),
                skipReasons: parsed.diagnostics.skipReasons,
                mappingSamples: mappingPlan.samples,
                timezonePolicy: {
                        configured: config.defaultTimezone ?? null,
                        explicitOffsetTimestamps: parsed.counts.explicitOffsetTimestamps,
                        defaultTimezoneTimestamps: parsed.counts.defaultTimezoneTimestamps
                }
        };
}

function epgPreviewFailure(kind: LivetvEpgRefreshFailureKind, message: string): LivetvEpgPreviewOutcome {
        return { ok: false, failure: { kind, message }, counts: null, parseSamples: null, skipReasons: null, mappingSamples: null, timezonePolicy: null };
}
