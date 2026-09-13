/**
 * MAVERO Stremio HTTP addon foundation — shared (client-safe) types.
 *
 * Phase 1 establishes the addon CONFIGURATION model only: no resolution, no
 * manifest fetching, no playback, no torrent/P2P support. The future MAVERO
 * Player branch (addons -> HTTP/HLS stream URLs -> native player) will build
 * on these types in later phases.
 *
 * This is a deliberately separate branch from the existing streaming
 * provider/source registry (streaming_providers / streaming_sources), which
 * remains untouched.
 */

export const addonStatuses = ['active', 'disabled', 'maintenance', 'experimental', 'unavailable'] as const;

export type StreamingAddonStatus = (typeof addonStatuses)[number];

export const defaultAddonStatus: StreamingAddonStatus = 'experimental';

export function isStreamingAddonStatus(value: unknown): value is StreamingAddonStatus {
  return typeof value === 'string' && addonStatuses.includes(value as StreamingAddonStatus);
}

/**
 * Domain representation of a Stremio HTTP addon registry record.
 *
 * Field naming follows the Mavero domain convention (camelCase); the
 * snake_case database mapping lives in the server streaming layer
 * (`mapAddonRow` / `mapAddonToInsert` in `$lib/server/streaming/addons`).
 *
 * Phase 1 note: manifest-derived metadata (idProperty, supportedTypes,
 * idPrefixes, resources) and health fields (lastCheckedAt, lastSuccessAt,
 * lastError) are part of the persisted model but are NOT populated by any
 * Phase 1 code — no fetching happens yet.
 */
export type StreamingAddon = {
  id: string;
  name: string;
  slug: string;
  description?: string;
  manifestUrl: string;
  enabled: boolean;
  status: StreamingAddonStatus;
  ordering: number;
  logo?: string;
  version?: string;
  idProperty?: string;
  supportedTypes: string[];
  idPrefixes: string[];
  resources: string[];
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  capabilities: Record<string, unknown>;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};
