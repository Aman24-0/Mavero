// ============================================================================
// Unified Live TV — Phase 1 registry model (server-side, configuration only).
//
// This module implements the DATA MODEL half of the unified Live TV pipeline:
//
//   Source Registry → Unified Channel Mapping → Configured Source/Endpoint
//   Priority → Playback Dispatcher → Playback Engine
//
// Four DISTINCT concepts are modeled separately (never mixed):
//   1. Source/provider ....... `livetv_sources` (+ typed `config` validated
//                              by `validateLivetvSourceConfig`).
//   2. Channel/endpoint map .. canonical `livetv_channels` + per-source
//                              `livetv_source_channels` + typed
//                              `livetv_playback_endpoints`.
//   3. Priority/fallback ..... `livetv_playback_candidates` ordering +
//                              source-level default priority.
//   4. Playback engine ....... DERIVED, never stored as a source: the
//                              endpoint KIND decides the engine
//                              (`playbackEngineForEndpoint`). Shaka and the
//                              iframe embed are playback mechanisms — they
//                              never appear in any source/priority list.
//
// ISOLATION CONTRACT (live-tv-plan §5/§13 decision D5, preserved):
//   This module shares NO types with the VOD `PlayerSource` shapes
//   (src/lib/shared/player.ts) and VOD code must not import this module.
//   The existing LiveGT V1 client (src/lib/client/live-tv/api.ts), the Shaka
//   engine (player.ts) and the LT-15 embed fallback are NOT re-implemented
//   here — later phases consume this registry AROUND them.
//
// PHASE 1 SCOPE (docs/livetv/LIVETV_PLAN.md §Phase 1):
//   Types, config/endpoint validation, effective-enablement rules and
//   deterministic candidate ordering — pure logic over plain row shapes, so
//   it is unit-testable without a database. DB I/O, Admin CRUD and runtime
//   dispatch belong to later phases. NO fetching happens in this module; the
//   SSRF guard (stremio/ssrf.ts stage-1) is applied HERE as a config-time
//   gate for URLs the SERVER will eventually fetch (Phase 2+).
//
// SIGNING/SECRECY NOTE: endpoint URLs stored by this model are CONFIGURATION
// (admin-entered or ingested) — never freshly-signed playback material. The
// LiveGT signed-resolution rule (never persist/cache/log resolution output,
// live-tv-plan §11) is untouched: resolutions still never enter these tables.
// ============================================================================

import { assertSafeManifestUrl } from '../streaming/stremio/ssrf';

// ---------------------------------------------------------------------------
// Closed vocabularies (mirror the migration CHECK constraints 1:1; widening
// either side is an additive, reviewed change).
// ---------------------------------------------------------------------------

/** Registered source/provider types (migration §2 CHECK). */
export const LIVETV_SOURCE_TYPES = [
        'builtin_livegt_v1',
        'm3u_playlist',
        'api_provider',
        'embed_provider',
        'manual_stream'
] as const;
export type LivetvSourceType = (typeof LIVETV_SOURCE_TYPES)[number];

/** Source lifecycle status (mirrors the Phase 7A vocabulary). */
export const LIVETV_SOURCE_STATUSES = [
        'active',
        'disabled',
        'maintenance',
        'experimental',
        'unavailable'
] as const;
export type LivetvSourceStatus = (typeof LIVETV_SOURCE_STATUSES)[number];

/** Statuses that keep a source eligible for playback resolution (rule S2). */
const PLAYBACK_ELIGIBLE_STATUSES: ReadonlySet<LivetvSourceStatus> = new Set([
        'active',
        'experimental',
        'maintenance'
]);

/**
 * Public form of the rule-S2 eligible-status set — the single normative
 * definition, shared with the Phase 2 refresh eligibility gates (a source
 * that is never playback-eligible is also never refresh-eligible).
 */
export const LIVETV_PLAYBACK_ELIGIBLE_STATUSES: ReadonlySet<LivetvSourceStatus> = PLAYBACK_ELIGIBLE_STATUSES;

/** User-facing exposure control. */
export const LIVETV_VISIBILITIES = ['public', 'internal', 'hidden'] as const;
export type LivetvVisibility = (typeof LIVETV_VISIBILITIES)[number];

/** Typed playback endpoint kinds — the dispatch discriminator. */
export const LIVETV_ENDPOINT_KINDS = ['direct_stream', 'embed_page'] as const;
export type LivetvEndpointKind = (typeof LIVETV_ENDPOINT_KINDS)[number];

/** Supported direct-media formats (the existing Live TV engine paths). */
export const LIVETV_STREAM_FORMATS = ['dash', 'hls'] as const;
export type LivetvStreamFormat = (typeof LIVETV_STREAM_FORMATS)[number];

/**
 * Playback engines — DERIVED from the endpoint kind, never configured as a
 * source. `shaka_media_player` = the existing Live TV Shaka engine
 * (src/lib/client/live-tv/player.ts); `iframe_embed` = the existing iframe
 * embed integration (LT-15 pattern, src/lib/components/live-tv/LiveTvPlayer.svelte).
 */
export const LIVETV_PLAYBACK_ENGINES = ['shaka_media_player', 'iframe_embed'] as const;
export type LivetvPlaybackEngine = (typeof LIVETV_PLAYBACK_ENGINES)[number];

/**
 * The single engine-routing table. Compile-time proof that every endpoint
 * kind maps to exactly one engine and that engines are chosen BY ENDPOINT
 * TYPE (requirement §4: an iframe URL can never be treated as a manifest).
 */
export const LIVETV_ENDPOINT_ENGINES: Readonly<
        Record<LivetvEndpointKind, LivetvPlaybackEngine>
> = {
        direct_stream: 'shaka_media_player',
        embed_page: 'iframe_embed'
};

/** Total, exhaustive engine routing for a validated endpoint kind. */
export function playbackEngineForEndpoint(kind: LivetvEndpointKind): LivetvPlaybackEngine {
        return LIVETV_ENDPOINT_ENGINES[kind];
}

// ---------------------------------------------------------------------------
// Typed error (mirrors StreamingValidationError conventions).
// ---------------------------------------------------------------------------

export class LivetvRegistryValidationError extends Error {
        constructor(message: string) {
                super(message);
                this.name = 'LivetvRegistryValidationError';
        }
}

// ---------------------------------------------------------------------------
// Row shapes (structural mirrors of the migration tables; DB reads type as
// these via src/lib/server/supabase/database.types.ts).
// ---------------------------------------------------------------------------

export type LivetvSourceRow = {
        id: string;
        slug: string;
        name: string;
        source_type: LivetvSourceType;
        builtin: boolean;
        enabled: boolean;
        status: LivetvSourceStatus;
        priority: number;
        visibility: LivetvVisibility;
        capabilities: Record<string, unknown>;
        config: Record<string, unknown>;
        description: string | null;
};

export type LivetvChannelRow = {
        id: string;
        name: string;
        category: string | null;
        logo_url: string | null;
        dedup_key: string | null;
        enabled: boolean;
};

export type LivetvSourceChannelRow = {
        id: string;
        source_id: string;
        source_channel_id: string;
        canonical_channel_id: string | null;
        name: string;
        category: string | null;
        logo_url: string | null;
        tvg_id: string | null;
        enabled: boolean;
};

export type LivetvEndpointRow = {
        id: string;
        source_channel_id: string;
        endpoint_kind: LivetvEndpointKind;
        stream_format: LivetvStreamFormat | null;
        url: string;
        ordering: number;
        enabled: boolean;
        label: string | null;
};

export type LivetvCandidateRow = {
        id: string;
        channel_id: string;
        endpoint_id: string;
        priority: number;
        enabled: boolean;
        created_at: string;
};

/**
 * camelCase model views consumed by the pure functions below. The DB-serving
 * layer (Phase 5) maps snake_case `database.types.ts` rows onto these
 * explicitly — the rename is deliberate, one-directional, and type-checked.
 */
export type LivetvSourceRef = {
        id: string;
        slug: string;
        sourceType: LivetvSourceType;
        enabled: boolean;
        status: LivetvSourceStatus;
        priority: number;
};

export type LivetvSourceChannelRef = {
        id: string;
        sourceId: string;
        sourceChannelId: string;
        canonicalChannelId: string | null;
        enabled: boolean;
};

export type LivetvEndpointRef = {
        id: string;
        sourceChannelId: string;
        kind: LivetvEndpointKind;
        streamFormat: LivetvStreamFormat | null;
        url: string;
        ordering: number;
        enabled: boolean;
        label: string | null;
};

// ---------------------------------------------------------------------------
// Typed per-source configuration (the `config` jsonb contract).
// Shapes are deliberately minimal for Phase 1; extension is additive.
// Unknown keys are REJECTED so no speculative or secret-bearing field can
// hide inside the config document.
// ---------------------------------------------------------------------------

/**
 * Phase 7 (scheduler): the OPTIONAL per-source refresh interval, expressed
 * through the EXISTING config jsonb contract (no scheduler configuration
 * table, no DDL). Present on the server-refreshable source types; absent ⇒
 * the scheduler default applies. Bounds: 15 minutes … 7 days (validated
 * here AND defensively re-validated by the scheduler at read time).
 */
export const LIVETV_REFRESH_INTERVAL_MIN_MINUTES = 15;
export const LIVETV_REFRESH_INTERVAL_MAX_MINUTES = 10_080;

export type LivetvRefreshIntervalConfig = { refreshIntervalMinutes?: number };

function validateRefreshIntervalMinutes(raw: unknown, label: string): number | undefined {
        if (raw === undefined) return undefined;
        if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
                fail(`${label} must be an integer number of minutes.`);
        }
        if (raw < LIVETV_REFRESH_INTERVAL_MIN_MINUTES || raw > LIVETV_REFRESH_INTERVAL_MAX_MINUTES) {
                fail(`${label} must be between ${LIVETV_REFRESH_INTERVAL_MIN_MINUTES} and ${LIVETV_REFRESH_INTERVAL_MAX_MINUTES} minutes.`);
        }
        return raw;
}

/** builtin_livegt_v1 — behavior lives in the existing client modules. */
export type LivetvBuiltinLivegtV1Config = LivetvRefreshIntervalConfig;

/** m3u_playlist — the playlist the server will fetch (SSRF-gated). */
export type LivetvM3UPlaylistConfig = LivetvRefreshIntervalConfig & { playlistUrl: string };

/** api_provider — the documented JSON API base (SSRF-gated). */
export type LivetvApiProviderConfig = LivetvRefreshIntervalConfig & { baseUrl: string };

/** embed_provider — iframe origin allowlist (rendered via the iframe integration). */
export type LivetvEmbedProviderConfig = { allowedOrigins: string[] };

/** manual_stream — endpoints are explicit rows; no upstream config. */
export type LivetvManualStreamConfig = Record<string, never>;

export type LivetvSourceConfig =
        | LivetvBuiltinLivegtV1Config
        | LivetvM3UPlaylistConfig
        | LivetvApiProviderConfig
        | LivetvEmbedProviderConfig
        | LivetvManualStreamConfig;

const PLAYLIST_URL_MAX_LENGTH = 2048;

function fail(message: string): never {
        throw new LivetvRegistryValidationError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(config: Record<string, unknown>, allowed: readonly string[], label: string): void {
        for (const key of Object.keys(config)) {
                if (!allowed.includes(key)) fail(`${label}: unknown config key "${key}".`);
        }
}

/**
 * Strict https URL validation for URLs the SERVER will fetch.
 * Enforces the documented https-only policy FIRST (plan §8.1), then reuses
 * the battle-tested stage-1 SSRF guard (host blocklist incl. cloud metadata,
 * IP-literal rejection incl. hex/octal/decimal and IPv4-mapped/NAT64 forms,
 * credential/whitespace/length checks).
 */
function validateServerFetchedHttpsUrl(raw: unknown, label: string): string {
        if (typeof raw !== 'string' || !raw.trim()) fail(`${label} is required.`);
        const trimmed = raw.trim();
        if (trimmed.length > PLAYLIST_URL_MAX_LENGTH) fail(`${label} must be ${PLAYLIST_URL_MAX_LENGTH} characters or fewer.`);
        if (!trimmed.startsWith('https://')) fail(`${label} must use https.`);
        // Stage-1 SSRF guard (throws ManifestServiceError on invalid/blocked).
        try {
                assertSafeManifestUrl(trimmed);
        } catch (error) {
                const message = error instanceof Error ? error.message : 'invalid URL';
                fail(`${label} was rejected by the URL safety guard: ${message}`);
        }
        return trimmed;
}

/** Normalizes + validates an https iframe origin (scheme://host[:port] only). */
function validateEmbedOrigin(raw: unknown, label: string): string {
        if (typeof raw !== 'string' || !raw.trim()) fail(`${label}: every allowed origin must be a non-empty string.`);
        let url: URL;
        try {
                url = new URL(raw.trim());
        } catch {
                fail(`${label}: "${String(raw)}" is not a valid origin.`);
        }
        if (url.protocol !== 'https:') fail(`${label}: origins must use https.`);
        if (url.username || url.password) fail(`${label}: origins must not contain credentials.`);
        if (url.pathname !== '/' || url.search || url.hash) fail(`${label}: origins must not include a path, query or hash.`);
        return url.origin;
}

/**
 * Validates the `config` jsonb for a source type. Returns the typed config
 * (the discriminator `sourceType` is validated separately at row level).
 */
export function validateLivetvSourceConfig(sourceType: LivetvSourceType, raw: unknown): LivetvSourceConfig {
        if (!isPlainObject(raw)) fail('Source config must be a JSON object.');
        const config = raw as Record<string, unknown>;

        switch (sourceType) {
                case 'builtin_livegt_v1': {
                        rejectUnknownKeys(config, ['refreshIntervalMinutes'], 'builtin_livegt_v1');
                        const interval = validateRefreshIntervalMinutes(config.refreshIntervalMinutes, 'builtin_livegt_v1.refreshIntervalMinutes');
                        return interval === undefined ? {} : { refreshIntervalMinutes: interval };
                }
                case 'm3u_playlist': {
                        rejectUnknownKeys(config, ['playlistUrl', 'refreshIntervalMinutes'], 'm3u_playlist');
                        // 2026-10 round 8 — Task 1: playlistUrl is OPTIONAL.
                        // A source may be created via file upload (no URL — the
                        // channels are ingested directly from the file content).
                        // Accepted values: a valid https URL, empty string, or
                        // the sentinel 'uploaded_file' (marks the source as
                        // file-uploaded — the Edit sheet hides the URL input and
                        // shows only the "Replace File" UI).
                        const interval = validateRefreshIntervalMinutes(config.refreshIntervalMinutes, 'm3u_playlist.refreshIntervalMinutes');
                        const rawUrl = typeof config.playlistUrl === 'string' ? config.playlistUrl.trim() : '';
                        let playlistUrl: string;
                        if (!rawUrl || rawUrl === 'uploaded_file') {
                                playlistUrl = rawUrl || '';
                        } else {
                                playlistUrl = validateServerFetchedHttpsUrl(rawUrl, 'm3u_playlist.playlistUrl');
                        }
                        return interval === undefined
                                ? { playlistUrl }
                                : { playlistUrl, refreshIntervalMinutes: interval };
                }
                case 'api_provider': {
                        rejectUnknownKeys(config, ['baseUrl', 'refreshIntervalMinutes'], 'api_provider');
                        if (config.baseUrl === undefined) fail('api_provider: "baseUrl" is required.');
                        const interval = validateRefreshIntervalMinutes(config.refreshIntervalMinutes, 'api_provider.refreshIntervalMinutes');
                        return interval === undefined
                                ? { baseUrl: validateServerFetchedHttpsUrl(config.baseUrl, 'api_provider.baseUrl') }
                                : { baseUrl: validateServerFetchedHttpsUrl(config.baseUrl, 'api_provider.baseUrl'), refreshIntervalMinutes: interval };
                }
                case 'embed_provider': {
                        rejectUnknownKeys(config, ['allowedOrigins'], 'embed_provider');
                        const origins = config.allowedOrigins;
                        if (!Array.isArray(origins) || origins.length === 0) fail('embed_provider: "allowedOrigins" must be a non-empty array.');
                        if (origins.length > 32) fail('embed_provider: at most 32 allowed origins.');
                        return { allowedOrigins: origins.map((origin, index) => validateEmbedOrigin(origin, `embed_provider.allowedOrigins[${index}]`)) };
                }
                case 'manual_stream': {
                        rejectUnknownKeys(config, [], 'manual_stream');
                        return {};
                }
        }
}

// ---------------------------------------------------------------------------
// Typed endpoint input validation — the type-safe boundary that keeps an
// iframe URL from ever being treated as an HLS/DASH manifest (requirement §4).
// The DB enforces the same pairing; this makes it explicit in application
// types and unit-testable without a database.
// ---------------------------------------------------------------------------

export type LivetvEndpointInput = {
        endpointKind: LivetvEndpointKind;
        /** REQUIRED for direct_stream (dash|hls); MUST be absent/null for embed_page. */
        streamFormat?: LivetvStreamFormat | null;
        url: string;
        ordering?: number;
        label?: string | null;
};

const ENDPOINT_URL_MAX_LENGTH = 2048;

/**
 * Structural validation for a browser-fetched playback URL. Playback stays
 * browser-direct (no Mavero proxy exists or is planned), so the SERVER-side
 * SSRF guard does not apply here; the https-only policy, length cap and
 * control-character ban do.
 */
function validatePlaybackUrl(raw: string): string {
        const trimmed = raw.trim();
        if (!trimmed) fail('Endpoint URL is required.');
        if (trimmed.length > ENDPOINT_URL_MAX_LENGTH) fail(`Endpoint URL must be ${ENDPOINT_URL_MAX_LENGTH} characters or fewer.`);
        if (!trimmed.startsWith('https://')) fail('Endpoint URL must use https.');
        if (/\s/.test(trimmed)) fail('Endpoint URL must not contain whitespace.');
        if (/[\u0000-\u001f\u007f]/.test(trimmed)) fail('Endpoint URL must not contain control characters.');
        let url: URL;
        try {
                url = new URL(trimmed);
        } catch {
                fail('Endpoint URL is not a valid absolute URL.');
        }
        if (url.username || url.password) fail('Endpoint URL must not contain credentials.');
        return trimmed;
}

/** Validates one endpoint input against the typed kind/format contract. */
export function validateLivetvEndpointInput(input: LivetvEndpointInput): {
        endpointKind: LivetvEndpointKind;
        streamFormat: LivetvStreamFormat | null;
        url: string;
        ordering: number;
        label: string | null;
} {
        if (!LIVETV_ENDPOINT_KINDS.includes(input.endpointKind)) fail('Endpoint kind must be direct_stream or embed_page.');
        if (typeof input.url !== 'string') fail('Endpoint URL is required.');
        const url = validatePlaybackUrl(input.url);

        let streamFormat: LivetvStreamFormat | null = null;
        if (input.endpointKind === 'direct_stream') {
                if (input.streamFormat !== 'dash' && input.streamFormat !== 'hls') {
                        fail('direct_stream endpoints require a streamFormat of dash or hls.');
                }
                streamFormat = input.streamFormat;
        } else if (input.streamFormat !== undefined && input.streamFormat !== null) {
                // Type-safe separation: an embed page is NOT a media manifest.
                fail('embed_page endpoints must not declare a streamFormat.');
        }

        const ordering = input.ordering ?? 0;
        if (!Number.isSafeInteger(ordering) || ordering < 0) fail('Endpoint ordering must be a non-negative integer.');

        let label: string | null = null;
        if (input.label !== undefined && input.label !== null) {
                const trimmedLabel = String(input.label).trim();
                if (!trimmedLabel || trimmedLabel.length > 120) fail('Endpoint label must be 1-120 characters.');
                label = trimmedLabel;
        }

        return { endpointKind: input.endpointKind, streamFormat, url, ordering, label };
}

// ---------------------------------------------------------------------------
// Effective enablement rules (requirement §5) — the single normative
// definition. A candidate is ELIGIBLE only when EVERY gate passes
// (conjunction along the chain source → source entry → endpoint → candidate,
// plus the canonical channel):
//
//   S1  source.enabled = true                       else source_disabled
//   S2  source.status ∈ {active,experimental,maintenance}
//                                                   else source_status_ineligible
//   C1  canonical channel.enabled = true            else channel_disabled
//   M0  source entry is MAPPED to this canonical channel
//                                                   else source_channel_unmapped
//   M1  source entry.enabled = true                 else source_channel_disabled
//   E1  endpoint.enabled = true                     else endpoint_disabled
//   P1  candidate.enabled = true                    else candidate_disabled
//
// A disabled source (or a disabled entry/endpoint/candidate anywhere along
// the chain) is therefore NEVER selected, and no gate can be bypassed by
// another gate being on.
// ---------------------------------------------------------------------------

export type LivetvCandidateBlockReason =
        | 'source_disabled'
        | 'source_status_ineligible'
        | 'channel_disabled'
        | 'source_channel_unmapped'
        | 'source_channel_disabled'
        | 'endpoint_disabled'
        | 'candidate_disabled';

export type LivetvCandidateRecord = {
        candidate: {
                /** Candidate row id as stored — the final deterministic tie-break. */
                rowId: string;
                channelId: string;
                endpointId: string;
                priority: number;
                enabled: boolean;
                createdAt: string;
        };
        endpoint: LivetvEndpointRef;
        sourceChannel: LivetvSourceChannelRef;
        source: LivetvSourceRef;
        channelEnabled: boolean;
};

/**
 * Returns WHY a candidate is blocked, or null when it is fully eligible.
 * Pure — the DB integrity trigger guarantees the candidate/endpoint/channel
 * relationship, and this re-verifies the mapped-chain invariant defensively
 * (M0) so a resolution can never follow an unmapped entry.
 */
export function explainLivetvCandidateBlock(record: LivetvCandidateRecord): LivetvCandidateBlockReason | null {
        if (!record.source.enabled) return 'source_disabled';
        if (!PLAYBACK_ELIGIBLE_STATUSES.has(record.source.status)) return 'source_status_ineligible';
        if (!record.channelEnabled) return 'channel_disabled';
        if (record.sourceChannel.canonicalChannelId === null) return 'source_channel_unmapped';
        if (!record.sourceChannel.enabled) return 'source_channel_disabled';
        if (!record.endpoint.enabled) return 'endpoint_disabled';
        if (!record.candidate.enabled) return 'candidate_disabled';
        return null;
}

/** Effective enablement: a candidate is playable only when no gate blocks it. */
export function isLivetvCandidateEligible(record: LivetvCandidateRecord): boolean {
        return explainLivetvCandidateBlock(record) === null;
}

// ---------------------------------------------------------------------------
// Deterministic ordering (requirement §5): explicit candidate rows are the
// authoritative per-channel order; with no rows at all, the source-level
// default order applies. Both modes share the same eligibility gates.
// ---------------------------------------------------------------------------

/** The resolved, playback-dispatch-ready candidate (engine derived from kind). */
export type LivetvOrderedCandidate = {
        /** Candidate row id, or a synthetic `default:<endpointId>` in default mode. */
        candidateId: string;
        endpointId: string;
        sourceSlug: string;
        sourceType: LivetvSourceType;
        endpointKind: LivetvEndpointKind;
        streamFormat: LivetvStreamFormat | null;
        /** Derived from the endpoint kind — never configured, never a source. */
        engine: LivetvPlaybackEngine;
        /**
         * The configured endpoint URL. Configuration data — never a freshly
         * signed playback resolution (those never enter the registry).
         */
        endpointUrl: string;
        endpointLabel: string | null;
};

/** Total, stable ordering key: (priority, createdAt, rowId). */
function compareExplicitCandidates(a: LivetvCandidateRecord, b: LivetvCandidateRecord): number {
        if (a.candidate.priority !== b.candidate.priority) return a.candidate.priority - b.candidate.priority;
        if (a.candidate.createdAt !== b.candidate.createdAt) return a.candidate.createdAt < b.candidate.createdAt ? -1 : 1;
        // UUID hex strings compare totally and stably — the final tie-break.
        return a.candidate.rowId < b.candidate.rowId ? -1 : a.candidate.rowId > b.candidate.rowId ? 1 : 0;
}

function toOrderedCandidate(record: LivetvCandidateRecord): LivetvOrderedCandidate {
        return {
                candidateId: record.candidate.rowId,
                endpointId: record.endpoint.id,
                sourceSlug: record.source.slug,
                sourceType: record.source.sourceType,
                endpointKind: record.endpoint.kind,
                streamFormat: record.endpoint.streamFormat,
                engine: playbackEngineForEndpoint(record.endpoint.kind),
                endpointUrl: record.endpoint.url,
                endpointLabel: record.endpoint.label
        };
}

/**
 * Explicit mode: ONLY candidate rows participate (an admin-materialized list
 * is authoritative; unlisted endpoints are not silently auto-included).
 * Deterministic tie-breaking: priority ASC → createdAt ASC → row id ASC.
 * Defensive endpoint dedupe: the DB unique(channel, endpoint) already
 * prevents duplicates; this guarantees no duplicate attempts/loops even if a
 * caller synthesizes bad input.
 */
export function orderExplicitLivetvCandidates(records: readonly LivetvCandidateRecord[]): LivetvOrderedCandidate[] {
        const seenEndpoints = new Set<string>();
        const ordered: LivetvOrderedCandidate[] = [];
        for (const record of [...records].filter(isLivetvCandidateEligible).sort(compareExplicitCandidates)) {
                if (seenEndpoints.has(record.endpoint.id)) continue;
                seenEndpoints.add(record.endpoint.id);
                ordered.push(toOrderedCandidate(record));
        }
        return ordered;
}

export type LivetvDefaultOrderInput = {
        channelEnabled: boolean;
        sources: readonly LivetvSourceRef[];
        sourceChannels: readonly LivetvSourceChannelRef[];
        endpoints: readonly LivetvEndpointRef[];
};

/**
 * Default mode (a channel with NO explicit candidate rows): derive the order
 * from the source-level priorities — sources ordered by (priority ASC, slug
 * ASC), then each mapped entry's endpoints by (ordering ASC, endpoint id
 * ASC). The same enablement gates apply; a disabled source is never selected
 * even in default mode.
 */
export function buildDefaultLivetvOrder(input: LivetvDefaultOrderInput): LivetvOrderedCandidate[] {
        const results: LivetvOrderedCandidate[] = [];
        if (!input.channelEnabled) return results;

        const endpointsBySourceChannel = new Map<string, LivetvDefaultOrderInput['endpoints'][number][]>();
        for (const endpoint of input.endpoints) {
                const bucket = endpointsBySourceChannel.get(endpoint.sourceChannelId) ?? [];
                bucket.push(endpoint);
                endpointsBySourceChannel.set(endpoint.sourceChannelId, bucket);
        }

        const orderedSources = [...input.sources].sort((a, b) => {
                if (a.priority !== b.priority) return a.priority - b.priority;
                return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
        });

        const seenEndpoints = new Set<string>();
        for (const source of orderedSources) {
                // Rules S1/S2 — a disabled (or non-eligible-status) source is never selected.
                if (!source.enabled || !PLAYBACK_ELIGIBLE_STATUSES.has(source.status)) continue;

                const entries = input.sourceChannels
                        .filter((entry) => entry.sourceId === source.id)
                        .sort((a, b) => (a.sourceChannelId < b.sourceChannelId ? -1 : a.sourceChannelId > b.sourceChannelId ? 1 : 0));

                for (const entry of entries) {
                        // Rules M0/M1 — unmapped or disabled entries never contribute.
                        if (entry.canonicalChannelId === null || !entry.enabled) continue;
                        const endpoints = [...(endpointsBySourceChannel.get(entry.id) ?? [])].sort((a, b) => {
                                if (a.ordering !== b.ordering) return a.ordering - b.ordering;
                                return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
                        });
                        for (const endpoint of endpoints) {
                                // Rule E1 + defensive endpoint dedupe (no duplicate attempts).
                                if (!endpoint.enabled || seenEndpoints.has(endpoint.id)) continue;
                                seenEndpoints.add(endpoint.id);
                                results.push({
                                        candidateId: `default:${endpoint.id}`,
                                        endpointId: endpoint.id,
                                        sourceSlug: source.slug,
                                        sourceType: source.sourceType,
                                        endpointKind: endpoint.kind,
                                        streamFormat: endpoint.streamFormat,
                                        engine: playbackEngineForEndpoint(endpoint.kind),
                                        endpointUrl: endpoint.url,
                                        endpointLabel: endpoint.label
                                });
                        }
                }
        }
        return results;
}

// ---------------------------------------------------------------------------
// Direct ENTRY resolution (R-0, additive): the ordered endpoints of ONE
// source entry selected directly (the `entry:<rowId>` catalogue identity).
// The canonical mapping gates (C1/M0) deliberately do NOT participate — an
// unmapped entry has no canonical row — but every other gate is re-enforced:
//
//   S1  source.enabled = true                       else source_disabled
//   S2  source.status ∈ {active,experimental,maintenance}
//                                                   else source_status_ineligible
//   M1  entry.enabled = true                        else source_channel_disabled
//   E1  endpoint.enabled = true                     else endpoint_disabled
//
// SOURCE VISIBILITY is additionally enforced by the RESOLVER (the row is
// loaded there) so a direct-entry selection can never bypass the catalogue's
// `visibility='public'` exposure rule. Ordering/dedupe/engine derivation
// follow buildDefaultLivetvOrder's conventions exactly.
// ---------------------------------------------------------------------------

export type LivetvDirectEntryOrderInput = {
        source: LivetvSourceRef;
        entry: LivetvSourceChannelRef;
        endpoints: readonly LivetvEndpointRef[];
};

/** Why a direct-entry selection contributes nothing (same taxonomy). */
export type LivetvDirectEntryBlockReason =
        | 'source_disabled'
        | 'source_status_ineligible'
        | 'source_channel_disabled';

/** Returns WHY the entry-direct selection is blocked, or null when eligible. */
export function explainLivetvDirectEntryBlock(input: LivetvDirectEntryOrderInput): LivetvDirectEntryBlockReason | null {
        if (!input.source.enabled) return 'source_disabled';
        if (!PLAYBACK_ELIGIBLE_STATUSES.has(input.source.status)) return 'source_status_ineligible';
        if (!input.entry.enabled) return 'source_channel_disabled';
        return null;
}

/**
 * The ordered, eligible endpoints of ONE directly-selected source entry
 * (endpoint ordering ASC, endpoint id ASC; defensive dedupe; engine derived
 * from the endpoint kind). A disabled source/entry contributes nothing.
 */
export function buildDirectLivetvEntryOrder(input: LivetvDirectEntryOrderInput): LivetvOrderedCandidate[] {
        if (explainLivetvDirectEntryBlock(input) !== null) return [];
        const results: LivetvOrderedCandidate[] = [];
        const seenEndpoints = new Set<string>();
        const endpoints = [...input.endpoints].sort((a, b) => {
                if (a.ordering !== b.ordering) return a.ordering - b.ordering;
                return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        for (const endpoint of endpoints) {
                // Rule E1 + defensive endpoint dedupe (no duplicate attempts).
                if (!endpoint.enabled || seenEndpoints.has(endpoint.id)) continue;
                if (endpoint.sourceChannelId !== input.entry.id) continue; // cross-entry guard (defense in depth)
                seenEndpoints.add(endpoint.id);
                results.push({
                        candidateId: `default:${endpoint.id}`,
                        endpointId: endpoint.id,
                        sourceSlug: input.source.slug,
                        sourceType: input.source.sourceType,
                        endpointKind: endpoint.kind,
                        streamFormat: endpoint.streamFormat,
                        engine: playbackEngineForEndpoint(endpoint.kind),
                        endpointUrl: endpoint.url,
                        endpointLabel: endpoint.label
                });
        }
        return results;
}

// ---------------------------------------------------------------------------
// Top-level resolution (mode detection only — no DB I/O in Phase 1).
// ---------------------------------------------------------------------------

export type LivetvResolutionInput = {
        channelId: string;
        /** Candidate rows for the channel, joined with endpoint/entry/source. */
        explicitRecords: readonly LivetvCandidateRecord[];
        /** Parts for the default derivation (used only when no rows exist). */
        defaults: LivetvDefaultOrderInput;
};

/**
 * Resolves the ordered, eligible playback candidates for one canonical
 * channel. Mode rule: if the channel has ANY explicit candidate rows, those
 * rows (eligible ones, deterministically ordered) are the whole list;
 * otherwise the source-priority default derivation applies. The output
 * carries the derived ENGINE per candidate — the dispatcher (Phase 5) routes
 * by `engine`/`endpointKind` and must never receive an engine from a
 * source/priority list.
 */
export function resolveLivetvPlaybackOrder(input: LivetvResolutionInput): { channelId: string; mode: 'explicit' | 'default'; candidates: LivetvOrderedCandidate[] } {
        if (input.explicitRecords.length > 0) {
                return { channelId: input.channelId, mode: 'explicit', candidates: orderExplicitLivetvCandidates(input.explicitRecords) };
        }
        return { channelId: input.channelId, mode: 'default', candidates: buildDefaultLivetvOrder(input.defaults) };
}
