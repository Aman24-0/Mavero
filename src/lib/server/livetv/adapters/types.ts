// ============================================================================
// Unified Live TV — Phase 2 adapter CONTRACT (server-only, typed, testable).
//
// The pipeline this layer implements (each concept stays DISTINCT):
//
//   Source Provider → Adapter → Normalized Source Channels →
//   Canonical Channel Mapping (ingestion) → Typed Playback Endpoints
//
// The adapter PARSES AND NORMALIZES provider data. It never chooses a
// player, never performs playback fallback, and never stores or infers a
// playback engine. Endpoint KIND (direct_stream vs embed_page) is the only
// dispatch-relevant classification, validated through the Phase 1 registry
// contract so an embed URL can never masquerade as a media manifest.
//
// Contract obligations (Phase 2 brief §3):
//   * Source type + adapter identity ......... `LivetvAdapterId`, `supports()`
//   * Validated source configuration ......... reuse of the Phase 1
//                                              `validateLivetvSourceConfig`
//   * Bounded fetching ....................... shared `fetch-safe.ts`
//   * Parsing + normalization ................ per-adapter, per-entry isolated
//   * Structured metadata + provenance ....... bounded `metadata` objects
//   * Normalized identity + source IDs ....... `NormalizedLivetvChannel`
//   * Typed endpoint extraction .............. `NormalizedLivetvEndpoint`
//   * Per-entry + source-level errors ........ `LivetvEntryError` /
//                                              `LivetvAdapterError`
//   * Capability reporting ................... `LivetvAdapterCapabilities`
//   * Cancellation / timeout ................. AbortSignal end-to-end
//   * Diagnostics that never leak secrets .... static safe reasons only
// ============================================================================

import {
        LIVETV_ENDPOINT_KINDS,
        LIVETV_SOURCE_TYPES,
        validateLivetvEndpointInput,
        LivetvRegistryValidationError,
        type LivetvEndpointKind,
        type LivetvSourceType,
        type LivetvStreamFormat
} from '../registry';
import { LivetvSourceFetchError } from '../fetch-safe';
import type { SafeDnsResolver } from '../../streaming/stremio/ssrf';

// ---------------------------------------------------------------------------
// Adapter identity
// ---------------------------------------------------------------------------

/** Registered Phase 2 adapters (the clear extension point for future types). */
export const LIVETV_ADAPTER_IDS = ['m3u_playlist', 'api_catalogue', 'builtin_livegt_v1'] as const;
export type LivetvAdapterId = (typeof LIVETV_ADAPTER_IDS)[number];

// ---------------------------------------------------------------------------
// Source-level typed error (one bad source never affects another source)
// ---------------------------------------------------------------------------

export type LivetvAdapterErrorKind =
        | 'adapter_unavailable'
        | 'invalid_source_config'
        | 'invalid_url'
        | 'blocked_url'
        | 'timeout'
        | 'too_large'
        | 'http_error'
        | 'network'
        | 'unsupported_media_type'
        | 'invalid_payload'
        | 'parse_failed'
        | 'entry_cap_exceeded'
        | 'parse_deadline_exceeded'
        | 'cancelled'
        | 'unexpected';

/** Source-level failure. Messages are static and diagnostics-safe. */
export class LivetvAdapterError extends Error {
        readonly kind: LivetvAdapterErrorKind;
        readonly httpStatus: number | null;

        constructor(kind: LivetvAdapterErrorKind, message: string, options: { httpStatus?: number; cause?: unknown } = {}) {
                super(message);
                this.name = 'LivetvAdapterError';
                this.kind = kind;
                this.httpStatus = options.httpStatus ?? null;
        }
}

const FETCH_KIND_TO_ADAPTER_KIND: Record<import('../fetch-safe').LivetvSourceFetchErrorKind, LivetvAdapterErrorKind> = {
        invalid_url: 'invalid_url',
        blocked_url: 'blocked_url',
        timeout: 'timeout',
        too_large: 'too_large',
        http_error: 'http_error',
        network: 'network',
        invalid_payload: 'invalid_payload',
        unsupported_media_type: 'unsupported_media_type',
        cancelled: 'cancelled',
        unexpected: 'unexpected'
};

        /** Shared mapping: bounded-fetch failure → adapter error (1:1 vocabulary). */
export function adapterErrorFromFetch(error: unknown): LivetvAdapterError {
        if (error instanceof LivetvSourceFetchError) {
                return new LivetvAdapterError(FETCH_KIND_TO_ADAPTER_KIND[error.kind], error.message, { httpStatus: error.httpStatus ?? undefined, cause: error });
        }
        return new LivetvAdapterError('unexpected', 'The source refresh failed unexpectedly.', { cause: error });
}

// ---------------------------------------------------------------------------
// Normalized shapes (pre-persistence; validated against the Phase 1 rules)
// ---------------------------------------------------------------------------

export type NormalizedLivetvEndpoint = {
        endpointKind: LivetvEndpointKind;
        /** REQUIRED for direct_stream; always null for embed_page (Phase 1 pairing). */
        streamFormat: LivetvStreamFormat | null;
        url: string;
        ordering: number;
        label: string | null;
};

export type NormalizedLivetvChannel = {
        /** The channel id AS THE SOURCE USES IT (provenance, 1–200, no whitespace/control). */
        sourceChannelId: string;
        name: string;
        category: string | null;
        /** https-only, ≤2048 (mirrors the DB CHECK). */
        logoUrl: string | null;
        /** Source-specific EPG identity (e.g. M3U tvg-id). */
        tvgId: string | null;
        endpoints: NormalizedLivetvEndpoint[];
        /** Bounded, scalar-only provenance metadata (see `sanitizeAdapterMetadata`). */
        metadata: Record<string, unknown>;
};

export type LivetvEntryErrorReason =
        | 'invalid_entry_shape'
        | 'missing_channel_id'
        | 'invalid_channel_id'
        | 'missing_name'
        | 'invalid_name'
        | 'invalid_logo_url'
        | 'invalid_category'
        | 'invalid_tvg_id'
        | 'missing_stream_url'
        | 'invalid_stream_url'
        | 'url_credentials_rejected'
        | 'non_https_stream_url'
        | 'url_too_long'
        | 'unknown_stream_format'
        | 'endpoint_validation_failed'
        | 'duplicate_channel_id'
        | 'embed_url_unavailable'
        | 'orphan_stream_url'
        | 'line_too_long'
        | 'metadata_overflow';

/** Per-entry failure — the entry is skipped with a structured, safe reason. */
export type LivetvEntryError = {
        /** Position of the entry in the source payload (0-based). */
        entryIndex: number;
        sourceChannelId: string | null;
        reason: LivetvEntryErrorReason;
};

export type LivetvAdapterDiagnostics = {
        /** Entries that normalized successfully (pre-dedup). */
        discoveredCount: number;
        /** Entries skipped for any reason (dedup + validation failures). */
        skippedCount: number;
        /** Static reason → count map (bounded to the reason vocabulary). */
        skippedReasons: Record<string, number>;
        /** Bounded sample of per-entry errors (the counts above stay complete). */
        entryErrors: LivetvEntryError[];
};

export type LivetvAdapterRunResult = {
        adapterId: LivetvAdapterId;
        channels: NormalizedLivetvChannel[];
        diagnostics: LivetvAdapterDiagnostics;
};

// ---------------------------------------------------------------------------
// Capability reporting (honest-by-construction; plan §4.3)
// ---------------------------------------------------------------------------

export type LivetvAdapterCapabilities = {
        /** The adapter can list/normalize channels. */
        catalogue: boolean;
        /** The SOURCE has a native guide (LiveGT V1: yes — untouched; playlists: no). */
        guide: boolean;
        logos: boolean;
        categories: boolean;
        /** Endpoint kinds this adapter can materialize from the source payload. */
        endpointKinds: readonly LivetvEndpointKind[];
        /**
         * How playback URLs come into existence:
         *   'static_urls'  — stable configuration URLs from the payload (persistable);
         *   'fresh_signed' — playback URLs are freshly resolved per playback and are
         *                    NEVER persisted (the built-in LiveGT V1 contract);
         *   'none'         — the payload declares no playback endpoints at all.
         */
        playbackResolution: 'static_urls' | 'fresh_signed' | 'none';
        refreshSupported: boolean;
};

// ---------------------------------------------------------------------------
// Adapter interface + shared run inputs
// ---------------------------------------------------------------------------

export type LivetvAdapterSourceRef = {
        id: string;
        slug: string;
        sourceType: LivetvSourceType;
        /** Raw `config` jsonb — validated by the adapter through the Phase 1 validator. */
        config: unknown;
};

export type LivetvAdapterDeps = {
        fetcher?: typeof fetch;
        dnsResolver?: SafeDnsResolver;
        /** Per-fetch timeout budget. */
        timeoutMs?: number;
        /** Response byte budget. */
        maxBytes?: number;
        maxRedirects?: number;
        /** Overall refresh deadline/cancellation signal (linked into every fetch). */
        signal?: AbortSignal;
        /** Deadline clock for parse loops (injectable for deterministic tests). */
        now?: () => number;
};

export interface LivetvSourceAdapter {
        readonly id: LivetvAdapterId;
        /** The source types this adapter serves (closed Phase 1 vocabulary). */
        readonly supportedSourceTypes: readonly LivetvSourceType[];
        supports(sourceType: LivetvSourceType): boolean;
        /** Honest capability report for the given validated source type. */
        capabilities(sourceType: LivetvSourceType): LivetvAdapterCapabilities;
        /**
         * Fetch + parse + normalize. Throws `LivetvAdapterError` for
         * source-level failures; per-entry problems are reported in the
         * result diagnostics (never thrown — one bad entry never fails the
         * source).
         */
        run(source: LivetvAdapterSourceRef, deps: LivetvAdapterDeps): Promise<LivetvAdapterRunResult>;
}

// ---------------------------------------------------------------------------
// Shared normalization helpers (all adapters; Phase 1 constraint parity)
// ---------------------------------------------------------------------------

const TEXT_MAX = { id: 200, name: 200, category: 120, tvg: 200 } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasWhitespaceOrControl(value: string): boolean {
        return /\s/.test(value) || /[\u0000-\u001f\u007f]/.test(value);
}

/** Validates a source-specific channel id (DB: 1–200, no whitespace/control). */
export function normalizeSourceChannelId(raw: unknown): string | null {
        if (typeof raw !== 'string') return null;
        const trimmed = raw.trim();
        if (!trimmed || trimmed.length > TEXT_MAX.id || hasWhitespaceOrControl(trimmed)) return null;
        return trimmed;
}

/** Validates a display name (DB: trimmed length 1–200). */
export function normalizeChannelName(raw: unknown): string | null {
        if (typeof raw !== 'string') return null;
        const trimmed = raw.trim();
        if (!trimmed || trimmed.length > TEXT_MAX.name) return null;
        // Control characters are hostile in display metadata — reject the
        // name rather than sanitizing it silently.
        if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
        return trimmed;
}

/**
 * Validates an optional bounded text field. `allowWhitespace=false` mirrors
 * the id-like DB constraints (no whitespace/control chars); `true` allows
 * human-readable text but still bans control characters.
 */
export function normalizeOptionalTextField(raw: unknown, maxLen: number, allowWhitespace: boolean): string | null {
        if (raw === undefined || raw === null) return null;
        if (typeof raw !== 'string') return null;
        const trimmed = raw.trim();
        if (!trimmed) return null;
        if (trimmed.length > maxLen) return null;
        if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
        if (!allowWhitespace && hasWhitespaceOrControl(trimmed)) return null;
        return trimmed;
}

/** Validates an optional https logo URL (DB: https, ≤2048, no control chars). */
export function normalizeLogoUrl(raw: unknown): string | null {
        if (raw === undefined || raw === null) return null;
        if (typeof raw !== 'string') return null;
        const trimmed = raw.trim();
        if (!trimmed) return null;
        if (trimmed.length > 2048) return null;
        if (/[\u0000-\u001f\u007f]/.test(trimmed) || /\s/.test(trimmed)) return null;
        if (!trimmed.startsWith('https://')) return null;
        try {
                const url = new URL(trimmed);
                if (url.username || url.password) return null;
        } catch {
                return null;
        }
        return trimmed;
}

/** Builds a validated normalized endpoint through the Phase 1 registry contract. */
export function buildNormalizedEndpoint(input: {
        endpointKind: LivetvEndpointKind;
        streamFormat?: LivetvStreamFormat | null;
        url: string;
        ordering?: number;
        label?: string | null;
}): NormalizedLivetvEndpoint {
        const validated = validateLivetvEndpointInput(input);
        return {
                endpointKind: validated.endpointKind,
                streamFormat: validated.streamFormat,
                url: validated.url,
                ordering: validated.ordering,
                label: validated.label
        };
}

/** True when the error is the Phase 1 registry validation error. */
export function isLivetvRegistryValidationError(error: unknown): error is LivetvRegistryValidationError {
        return error instanceof LivetvRegistryValidationError;
}

export { LIVETV_ENDPOINT_KINDS, LIVETV_SOURCE_TYPES };

// ---------------------------------------------------------------------------
// Bounded, scalar-only provenance metadata (raw payloads never spread)
// ---------------------------------------------------------------------------

export const ADAPTER_METADATA_MAX_KEYS = 24;
const METADATA_KEY_MAX = 40;
const METADATA_VALUE_MAX = 300;

/**
 * Sanitizes adapter provenance into the bounded shape the DB `metadata`
 * jsonb accepts: flat object, ≤24 keys, string keys ≤40 chars, values
 * restricted to string (≤300) / number (finite) / boolean / null. Anything
 * else (nested objects, arrays, huge strings, non-finite numbers) is dropped.
 */
export function sanitizeAdapterMetadata(raw: unknown): Record<string, unknown> {
        if (!isRecord(raw)) return {};
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(raw)) {
                if (Object.keys(out).length >= ADAPTER_METADATA_MAX_KEYS) break;
                if (!key || key.length > METADATA_KEY_MAX) continue;
                if (value === null) {
                        out[key] = null;
                        continue;
                }
                if (typeof value === 'boolean' || typeof value === 'number') {
                        out[key] = typeof value === 'number' && !Number.isFinite(value) ? null : value;
                        continue;
                }
                if (typeof value === 'string') {
                        const trimmed = value.trim();
                        if (!trimmed || trimmed.length > METADATA_VALUE_MAX) continue;
                        if (/[\u0000-\u001f\u007f]/.test(trimmed)) continue;
                        out[key] = trimmed;
                }
                // Nested objects/arrays are deliberately dropped — provenance
                // stays bounded and flat.
        }
        return out;
}
