// ============================================================================
// Unified Live TV — Phase 2 built-in LiveGT V1 catalogue adapter (server-only).
//
// Normalizes the EXISTING LiveGT V1 integration's public catalogue into the
// unified model. LiveGT V1 itself is COMPLETELY untouched: the client
// (src/lib/client/live-tv/api.ts), the player, media-auth, the EPG helpers
// and the LT-15 embed fallback keep their exact behavior (golden behaviors,
// docs/livetv/LIVETV_PLAN.md §10).
//
// REUSE (Phase 2 brief §6 — "reuse the existing client … do not duplicate
// provider logic unnecessarily"):
//   * The base URL and the documented embed URL builder are IMPORTED from
//     the existing client module — this file never spells the provider
//     hostname (the repo's LiveGT-isolation guard keeps that literal in
//     api.ts alone) and never re-implements embed URL rules (digits-only
//     validation lives in the client's builder).
//   * The wire shape is normalized through the shared catalogue engine
//     (`api-catalogue.ts`) using the documented catalogue profile.
//
// PLAYBACK ENDPOINT POLICY (brief §6 — "If … can be represented safely"):
//   * Embed page — REPRESENTABLE: the documented `{base}/embed/{id}` page is
//     stable, secret-free configuration. Each catalogue entry with a valid
//     id gets a typed `embed_page` endpoint (rendered by the existing iframe
//     integration in Phase 5+).
//   * Direct stream — NOT representable as a persisted row: LiveGT playback
//     URLs are freshly signed per playback and their contract FORBIDS
//     caching/persisting resolutions (live-tv-plan §11, decision D6; the
//     catalogue payload itself carries no playable stream URL — its
//     `embed`/`watch` wire fields are deliberately never read, exactly like
//     the existing client). The direct path therefore remains resolution-
//     based through the existing client; the adapter reports it honestly via
//     `playbackResolution: 'fresh_signed'` instead of inventing a URL.
//     Nothing in this adapter probes per-channel playback endpoints, and no
//     signed material ever enters the registry.
// ============================================================================

import { LIVEGT_V1_BASE_URL, buildLiveTvEmbedUrl } from '../../../client/live-tv/api';
import { validateLivetvSourceConfig } from '../registry';
import { fetchLivetvSourceJson } from '../fetch-safe';
import {
        LivetvAdapterError,
        adapterErrorFromFetch,
        buildNormalizedEndpoint,
        isLivetvRegistryValidationError,
        type LivetvAdapterCapabilities,
        type LivetvAdapterDeps,
        type LivetvAdapterRunResult,
        type LivetvAdapterSourceRef,
        type LivetvSourceAdapter
} from './types';
import { LIVETV_DOCUMENTED_CATALOGUE_PROFILE_V1, normalizeApiCataloguePayload, type LivetvCatalogueRunProfile } from './api-catalogue';

/** The documented LiveGT V1 catalogue path (fixed V1 contract — api.ts). */
const LIVEGT_V1_CATALOGUE_PATH = '/api/public/channels';

/** Runtime profile binding: documented shape + the built-in adapter identity. */
const LIVEGT_V1_PROFILE: LivetvCatalogueRunProfile = {
        adapterId: 'builtin_livegt_v1',
        profile: LIVETV_DOCUMENTED_CATALOGUE_PROFILE_V1
};

export const livegtV1Adapter: LivetvSourceAdapter = {
        id: 'builtin_livegt_v1',
        supportedSourceTypes: ['builtin_livegt_v1'],

        supports(sourceType) {
                return sourceType === 'builtin_livegt_v1';
        },

        capabilities(_sourceType): LivetvAdapterCapabilities {
                return {
                        catalogue: true,
                        // The built-in source keeps its NATIVE V1 guide (untouched);
                        // the unified ingestion never parses it (Phase 3 boundary).
                        guide: true,
                        logos: true,
                        categories: true,
                        // Only the embed page is materializable from the catalogue;
                        // direct streams stay fresh-signed (header note).
                        endpointKinds: ['embed_page'],
                        playbackResolution: 'fresh_signed',
                        refreshSupported: true
                };
        },

        async run(source: LivetvAdapterSourceRef, deps: LivetvAdapterDeps): Promise<LivetvAdapterRunResult> {
                try {
                        validateLivetvSourceConfig('builtin_livegt_v1', source.config);
                } catch (error) {
                        if (isLivetvRegistryValidationError(error)) {
                                throw new LivetvAdapterError('invalid_source_config', 'The source configuration failed validation.', { cause: error });
                        }
                        throw error;
                }

                // Fixed documented V1 endpoint built from the client's own base
                // constant — never user-controlled, never a proxy target.
                const url = `${LIVEGT_V1_BASE_URL}${LIVEGT_V1_CATALOGUE_PATH}`;
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

                const normalized = normalizeApiCataloguePayload(body, LIVEGT_V1_PROFILE.profile, LIVEGT_V1_PROFILE.maxEntries !== undefined ? { maxEntries: LIVEGT_V1_PROFILE.maxEntries } : undefined);

                // Materialize the documented embed page per entry. A failed
                // embed build (non-digit id — never observed in the V1
                // catalogue) degrades to a per-entry diagnostic; the entry
                // itself stays (its identity/metadata remain useful).
                const entryErrors = [...normalized.diagnostics.entryErrors];
                const skippedReasons: Record<string, number> = { ...normalized.diagnostics.skippedReasons };
                const channels = normalized.channels.map((channel) => {
                        const embedUrl = buildLiveTvEmbedUrl(channel.sourceChannelId);
                        if (!embedUrl) {
                                skippedReasons['embed_url_unavailable'] = (skippedReasons['embed_url_unavailable'] ?? 0) + 1;
                                if (entryErrors.length < 200) {
                                        entryErrors.push({ entryIndex: -1, sourceChannelId: channel.sourceChannelId, reason: 'embed_url_unavailable' });
                                }
                                return channel;
                        }
                        const endpoint = buildNormalizedEndpoint({
                                endpointKind: 'embed_page',
                                url: embedUrl,
                                ordering: 0,
                                label: null
                        });
                        return { ...channel, endpoints: [endpoint, ...channel.endpoints] };
                });

                return {
                        adapterId: 'builtin_livegt_v1',
                        channels,
                        diagnostics: {
                                discoveredCount: normalized.diagnostics.discoveredCount,
                                skippedCount: normalized.diagnostics.skippedCount,
                                skippedReasons,
                                entryErrors
                        }
                };
        }
};
