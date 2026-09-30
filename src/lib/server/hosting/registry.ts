/**
 * Phase 4 — Hosting adapter registry.
 *
 * Maps streaming_sources rows to their Phase 3 HostingProviderAdapter
 * instances. The registry is keyed by the provider's `adapter_id`
 * field (e.g. 'vidara', 'abyss'), which is stored in the
 * `streaming_providers.adapter_id` column.
 *
 * The registry is SERVER-SIDE ONLY — it instantiates adapters that
 * read credentials from `$env/dynamic/private`. The adapters are
 * NEVER exposed to the client.
 *
 * Usage:
 *   import { getHostingAdapterForProvider } from '$lib/server/hosting/registry';
 *   const adapter = getHostingAdapterForProvider(provider);
 *   if (adapter) { const asset = await adapter.getAsset(filecode); }
 *
 * If the provider is not a hosting provider (no adapter_id matching
 * a known hosting adapter), returns null. This allows the existing
 * resolver architecture to ignore hosting providers that haven't been
 * wired yet (e.g. during Phase 4, the sources are registered but the
 * playback resolver doesn't yet check media_assets).
 */

import type { HostingProviderAdapter, HostingProviderKey } from './types';
import { VidaraAdapter } from './vidara/adapter';
import { AbyssAdapter } from './abyss/adapter';
import { createVidaraConfig, getVidaraConfigOrNull } from './vidara/config';
import { createAbyssConfig, getAbyssConfigOrNull } from './abyss/config';

// ---------------------------------------------------------------------------
// Adapter cache (module-level — credentials are read once at startup)
// ---------------------------------------------------------------------------

let vidaraAdapter: VidaraAdapter | null = null;
let abyssAdapter: AbyssAdapter | null = null;

function getVidaraAdapter(): VidaraAdapter | null {
  if (vidaraAdapter) return vidaraAdapter;
  const config = getVidaraConfigOrNull();
  if (!config) return null;
  vidaraAdapter = new VidaraAdapter({ config });
  return vidaraAdapter;
}

function getAbyssAdapter(): AbyssAdapter | null {
  if (abyssAdapter) return abyssAdapter;
  const config = getAbyssConfigOrNull();
  if (!config) return null;
  abyssAdapter = new AbyssAdapter({ config });
  return abyssAdapter;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Map of adapter_id → hosting provider key.
 * This matches the `adapter_id` column on `streaming_providers`.
 */
const ADAPTER_ID_TO_KEY: Record<string, HostingProviderKey> = {
  vidara: 'vidara',
  abyss: 'abyss',
};

/**
 * Returns the HostingProviderAdapter for a given provider adapter_id,
 * or null if:
 *   - the adapter_id is not a hosting adapter
 *   - the provider's credentials are not configured
 *
 * The provider row is identified by its `adapter_id` field
 * (e.g. 'vidara', 'abyss').
 */
export function getHostingAdapter(adapterId: string | null | undefined): HostingProviderAdapter | null {
  if (!adapterId) return null;
  const key = ADAPTER_ID_TO_KEY[adapterId];
  if (!key) return null;
  switch (key) {
    case 'vidara': return getVidaraAdapter();
    case 'abyss': return getAbyssAdapter();
    default: return null;
  }
}

/**
 * Returns the HostingProviderAdapter for a given provider row shape.
 * Accepts a minimal provider shape with at least `adapter_id`.
 */
export function getHostingAdapterForProvider(provider: { adapter_id?: string | null }): HostingProviderAdapter | null {
  return getHostingAdapter(provider.adapter_id);
}

/**
 * Returns all registered hosting adapter keys.
 */
export function getHostingAdapterKeys(): HostingProviderKey[] {
  return Object.keys(ADAPTER_ID_TO_KEY) as HostingProviderKey[];
}
