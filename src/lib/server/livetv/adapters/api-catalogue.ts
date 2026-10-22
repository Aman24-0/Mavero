// ============================================================================
// Unified Live TV — Phase 2 JSON/API catalogue adapter (server-only).
//
// A GENERIC, mapping-driven catalogue engine plus the ONLY provider shape
// supported in Phase 2: the documented catalogue JSON profile inspected from
// real provider documentation (the LiveGT V1 public catalogue shape:
// `{ channels: [{ id, name, category?, logo? }] }` — docs/livetv/ Phase 0
// probe + src/lib/client/live-tv/api.ts normalizer contract).
//
// HARD RULES (Phase 2 brief §5):
//   * Explicit, validated JSON field mappings — the profile below is a typed
//     constant, not a guess. A NEW provider requires a NEW documented
//     profile in reviewed code; no user-supplied mappings, no arbitrary code
//     execution, no undocumented APIs.
//   * Bounded response size + timeout (fetch-safe.ts), content-type +
//     payload-shape validation, per-entry error isolation.
//   * No hard-coded assumption that an API returns direct streams. Endpoint
//     fields are mapped ONLY when a profile declares them, and each endpoint
//     is classified INDEPENDENTLY (direct vs embed) — the source TYPE never
//     determines the playback engine.
// ============================================================================

import { validateLivetvSourceConfig, type LivetvApiProviderConfig } from '../registry';
import { fetchLivetvSourceJson } from '../fetch-safe';
import {
        LivetvAdapterError,
        adapterErrorFromFetch,
        buildNormalizedEndpoint,
        isLivetvRegistryValidationError,
        normalizeChannelName,
        normalizeLogoUrl,
        normalizeOptionalTextField,
        normalizeSourceChannelId,
        sanitizeAdapterMetadata,
        type LivetvAdapterCapabilities,
        type LivetvAdapterDeps,
        type LivetvAdapterDiagnostics,
        type LivetvAdapterRunResult,
        type LivetvAdapterSourceRef,
        type LivetvEntryErrorReason,
        type LivetvSourceAdapter,
        type NormalizedLivetvChannel,
        type NormalizedLivetvEndpoint
} from './types';

// ---------------------------------------------------------------------------
// The explicit profile contract
// ---------------------------------------------------------------------------

/**
 * One documented provider mapping. `field` names are explicit JSON keys from
 * the provider's published documentation — never inferred, never user-supplied.
 */
export type LivetvApiEndpointFieldMapping = {
        /** The entry JSON key holding the endpoint URL. */
        field: string;
        /** Explicit endpoint kind — REQUIRED in the mapping, never inferred. */
        kind: 'direct_stream' | 'embed_page';
        /** REQUIRED when kind is direct_stream (the documented payload format). */
        streamFormat?: 'dash' | 'hls';
        /** Stable endpoint label persisted with the endpoint row. */
        label: string;
};

export type LivetvApiCatalogueProfile = {
        /** Stable profile identity (diagnostics + future provider registry). */
        profileId: string;
        /** Path of the catalogue endpoint relative to the validated base URL. */
        cataloguePath: string;
        /** Top-level key holding the channel array. */
        channelsKey: string;
        /** Explicit entry field names. */
        fields: {
                id: string;
                name: string;
                category: string | null;
                logo: string | null;
        };
        /**
         * Explicit endpoint mappings. An EMPTY list means the documented
         * payload carries no playback endpoints (the honest default — the
         * engine never assumes one).
         */
        endpoints: readonly LivetvApiEndpointFieldMapping[];
        /** Maximum entries accepted from this profile's payload. */
        maxEntries: number;
};

/**
 * The one Phase 2 profile: the DOCUMENTED catalogue JSON shape inspected
 * from real provider documentation (LiveGT V1's public catalogue). It maps
 * NO playback endpoint fields: that provider's playback URLs are freshly
 * signed per playback (never persistable) and its embed page is a
 * source-specific, id-built contract handled by the built-in adapter.
 */
export const LIVETV_DOCUMENTED_CATALOGUE_PROFILE_V1: LivetvApiCatalogueProfile = {
        profileId: 'documented-catalogue-json-v1',
        cataloguePath: '/api/public/channels',
        channelsKey: 'channels',
        fields: { id: 'id', name: 'name', category: 'category', logo: 'logo' },
        endpoints: [],
        maxEntries: 20_000
};

// ---------------------------------------------------------------------------
// Shared normalization engine (also consumed by the built-in LiveGT adapter)
// ---------------------------------------------------------------------------

export type ApiCatalogueNormalizeOptions = {
        maxEntries?: number;
};

export type ApiCatalogueNormalizeResult = {
        channels: NormalizedLivetvChannel[];
        diagnostics: LivetvAdapterDiagnostics;
};

const ENTRY_ERRORS_SAMPLE = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalizes one entry; returns a reason string on failure (isolated). */
function normalizeCatalogueEntry(
        raw: unknown,
        entryIndex: number,
        profile: LivetvApiCatalogueProfile,
        seenIds: Set<string>
): { ok: true; value: NormalizedLivetvChannel } | { ok: false; reason: LivetvEntryErrorReason } {
        if (!isRecord(raw)) return { ok: false, reason: 'invalid_entry_shape' };

        const sourceChannelId = normalizeSourceChannelId(raw[profile.fields.id]);
        if (sourceChannelId === null) {
                return { ok: false, reason: raw[profile.fields.id] === undefined ? 'missing_channel_id' : 'invalid_channel_id' };
        }
        if (seenIds.has(sourceChannelId)) return { ok: false, reason: 'duplicate_channel_id' };

        const name = normalizeChannelName(raw[profile.fields.name]);
        if (name === null) return { ok: false, reason: raw[profile.fields.name] === undefined ? 'missing_name' : 'invalid_name' };

        const category = profile.fields.category ? normalizeOptionalTextField(raw[profile.fields.category], 120, true) : null;
        if (profile.fields.category && raw[profile.fields.category] !== undefined && raw[profile.fields.category] !== null && category === null) {
                return { ok: false, reason: 'invalid_category' };
        }

        let logoUrl: string | null = null;
        if (profile.fields.logo) {
                const rawLogo = raw[profile.fields.logo];
                if (rawLogo !== undefined && rawLogo !== null) {
                        logoUrl = normalizeLogoUrl(rawLogo);
                        if (logoUrl === null) return { ok: false, reason: 'invalid_logo_url' };
                }
        }

        // Endpoint extraction — ONLY through explicit profile mappings, each
        // classified independently (kind comes from the mapping, never from
        // the source type; a failed mapping skips just that endpoint's entry).
        const endpoints: NormalizedLivetvEndpoint[] = [];
        for (const mapping of profile.endpoints) {
                const rawUrl = raw[mapping.field];
                if (rawUrl === undefined || rawUrl === null) continue;
                if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
                        return { ok: false, reason: 'invalid_stream_url' };
                }
                try {
                        endpoints.push(
                                buildNormalizedEndpoint({
                                        endpointKind: mapping.kind,
                                        streamFormat: mapping.kind === 'direct_stream' ? mapping.streamFormat ?? null : null,
                                        url: rawUrl.trim(),
                                        ordering: endpoints.length,
                                        label: mapping.label
                                })
                        );
                } catch (error) {
                        if (isLivetvRegistryValidationError(error)) {
                                return { ok: false, reason: 'endpoint_validation_failed' };
                        }
                        throw error;
                }
        }

        seenIds.add(sourceChannelId);
        return {
                ok: true,
                value: {
                        sourceChannelId,
                        name,
                        category,
                        logoUrl,
                        tvgId: null,
                        endpoints,
                        metadata: sanitizeAdapterMetadata({ sourceFormat: 'api', profile: profile.profileId })
                }
        };
}

/**
 * Validates the payload shape against the profile and normalizes every
 * entry with per-entry isolation. A non-object payload or a missing/malformed
 * channels array is a SOURCE-level failure; individual entries fail alone.
 */
export function normalizeApiCataloguePayload(payload: unknown, profile: LivetvApiCatalogueProfile, options: ApiCatalogueNormalizeOptions = {}): ApiCatalogueNormalizeResult {
        const maxEntries = options.maxEntries ?? profile.maxEntries;
        if (!isRecord(payload)) {
                throw new LivetvAdapterError('invalid_payload', 'The catalogue payload is not a JSON object.');
        }
        const list = payload[profile.channelsKey];
        if (!Array.isArray(list)) {
                throw new LivetvAdapterError('invalid_payload', 'The catalogue payload does not contain a channel array.');
        }
        if (list.length > maxEntries) {
                throw new LivetvAdapterError('entry_cap_exceeded', 'The catalogue exceeds the configured entry budget.');
        }

        const channels: NormalizedLivetvChannel[] = [];
        const seenIds = new Set<string>();
        const reasons = new Map<LivetvEntryErrorReason, number>();
        const entryErrors: { entryIndex: number; sourceChannelId: string | null; reason: LivetvEntryErrorReason }[] = [];
        let discoveredCount = 0;
        let skippedCount = 0;

        for (let entryIndex = 0; entryIndex < list.length; entryIndex += 1) {
                const result = normalizeCatalogueEntry(list[entryIndex], entryIndex, profile, seenIds);
                if (result.ok) {
                        channels.push(result.value);
                        discoveredCount += 1;
                        continue;
                }
                skippedCount += 1;
                reasons.set(result.reason, (reasons.get(result.reason) ?? 0) + 1);
                if (entryErrors.length < ENTRY_ERRORS_SAMPLE) {
                        const rawEntry = list[entryIndex];
                        entryErrors.push({
                                entryIndex,
                                sourceChannelId: isRecord(rawEntry) ? normalizeSourceChannelId(rawEntry[profile.fields.id]) : null,
                                reason: result.reason
                        });
                }
        }

        const skippedReasons: Record<string, number> = {};
        for (const [reason, count] of reasons) skippedReasons[reason] = count;
        return {
                channels,
                diagnostics: { discoveredCount, skippedCount, skippedReasons, entryErrors }
        };
}

// ---------------------------------------------------------------------------
// The generic api_provider adapter
// ---------------------------------------------------------------------------

/** Fetches + normalizes one catalogue document through a profile. */
export async function runCatalogueProfile(source: LivetvAdapterSourceRef, profile: LivetvCatalogueRunProfile, deps: LivetvAdapterDeps): Promise<LivetvAdapterRunResult> {
        let config: LivetvApiProviderConfig;
        try {
                config = validateLivetvSourceConfig('api_provider', source.config) as LivetvApiProviderConfig;
        } catch (error) {
                if (isLivetvRegistryValidationError(error)) {
                        throw new LivetvAdapterError('invalid_source_config', 'The source configuration failed validation.', { cause: error });
                }
                throw error;
        }
        const base = config.baseUrl.replace(/\/+$/, '');
        const url = `${base}${profile.profile.cataloguePath}`;
        let body: unknown;
        try {
                body = (await fetchLivetvSourceJson(url, {
                        fetcher: deps.fetcher,
                        dnsResolver: deps.dnsResolver,
                        timeoutMs: deps.timeoutMs,
                        maxBytes: deps.maxBytes,
                        maxRedirects: deps.maxRedirects,
                        signal: deps.signal
                })).body;
        } catch (error) {
                throw adapterErrorFromFetch(error);
        }
        const normalized = normalizeApiCataloguePayload(body, profile.profile, { maxEntries: profile.maxEntries });
        return { adapterId: profile.adapterId, channels: normalized.channels, diagnostics: normalized.diagnostics };
}

/** Runtime profile binding (adapter identity + optional entry budget override). */
export type LivetvCatalogueRunProfile = {
        adapterId: 'api_catalogue' | 'builtin_livegt_v1';
        profile: LivetvApiCatalogueProfile;
        maxEntries?: number;
};

export const apiCatalogueAdapter: LivetvSourceAdapter = {
        id: 'api_catalogue',
        supportedSourceTypes: ['api_provider'],

        supports(sourceType) {
                return sourceType === 'api_provider';
        },

        capabilities(_sourceType): LivetvAdapterCapabilities {
                return {
                        catalogue: true,
                        guide: false,
                        logos: true,
                        categories: true,
                        endpointKinds: LIVETV_DOCUMENTED_CATALOGUE_PROFILE_V1.endpoints.map((mapping) => mapping.kind),
                        playbackResolution: LIVETV_DOCUMENTED_CATALOGUE_PROFILE_V1.endpoints.length ? 'static_urls' : 'none',
                        refreshSupported: true
                };
        },

        async run(source: LivetvAdapterSourceRef, deps: LivetvAdapterDeps): Promise<LivetvAdapterRunResult> {
                return runCatalogueProfile(source, { adapterId: 'api_catalogue', profile: LIVETV_DOCUMENTED_CATALOGUE_PROFILE_V1 }, deps);
        }
};
