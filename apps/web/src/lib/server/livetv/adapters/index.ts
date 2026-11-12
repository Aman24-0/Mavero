// ============================================================================
// Unified Live TV — Phase 2 adapter registry (the extension interface).
//
// Maps each Phase 1 source type onto its Phase 2 adapter. Future source
// types join by implementing `LivetvSourceAdapter` and adding one entry
// here — a clear, typed extension point (Phase 2 brief §1/§3).
//
// Phase 2 intentionally ships NO adapter for `embed_provider` (iframe
// origins need no catalogue ingestion) or `manual_stream` (admin-entered
// endpoints have no upstream to fetch) — requesting them for refresh is a
// typed `adapter_unavailable` error, never a silent no-op.
// ============================================================================

import { m3uPlaylistAdapter } from './m3u';
import { apiCatalogueAdapter } from './api-catalogue';
import { livegtV1Adapter } from './livegt-v1';
import { LivetvAdapterError, type LivetvAdapterId, type LivetvSourceAdapter } from './types';
import type { LivetvSourceType } from '../registry';

/** All registered adapters (registration order is diagnostics-only). */
export const LIVETV_ADAPTERS: readonly LivetvSourceAdapter[] = [m3uPlaylistAdapter, apiCatalogueAdapter, livegtV1Adapter];

/**
 * Resolves the adapter for a source type, or null when no adapter exists
 * for it in Phase 2 (embed_provider / manual_stream / future types).
 */
export function resolveLivetvAdapter(sourceType: LivetvSourceType): LivetvSourceAdapter | null {
        for (const adapter of LIVETV_ADAPTERS) {
                if (adapter.supports(sourceType)) return adapter;
        }
        return null;
}

/** Resolves the adapter or throws the typed `adapter_unavailable` error. */
export function requireLivetvAdapter(sourceType: LivetvSourceType): LivetvSourceAdapter {
        const adapter = resolveLivetvAdapter(sourceType);
        if (!adapter) {
                throw new LivetvAdapterError('adapter_unavailable', 'No source adapter is available for this source type yet.');
        }
        return adapter;
}

/** Adapter identity for a source type (diagnostics; null when unregistered). */
export function livetvAdapterIdFor(sourceType: LivetvSourceType): LivetvAdapterId | null {
        return resolveLivetvAdapter(sourceType)?.id ?? null;
}
