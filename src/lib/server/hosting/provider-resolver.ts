/**
 * Phase C (audit fix) — Canonical Provider Resolver.
 *
 * SINGLE SOURCE OF TRUTH for answering:
 *   "Given a media_asset.provider_source_id, what provider (adapter_id,
 *    name) does it belong to?"
 *
 * WHY THIS EXISTS
 *
 * Before this module, the answer was computed in at least 5 places:
 *   1. /admin/media/library/+page.server.ts  — two explicit queries,
 *      app-code join, NO enabled filter (post-fix).
 *   2. /admin/media/upload/+page.server.ts   — two explicit queries,
 *      app-code join, WITH enabled=true filter (FINDING-004 — bug).
 *   3. AdminMediaTable.svelte               — adapterIdForSource() on
 *      the client, using the hostingSources list from #1.
 *   4. AdminMediaCard.svelte                — identical duplicate of #3.
 *   5. AdminMediaDetailDrawer.svelte        — identical duplicate of #3,
 *      plus sourceNameForId().
 *
 * Plus the upload service, status route, complete route, upload-server
 * route, management service, and sync service all do their own
 * streaming_sources → streaming_providers two-query lookup inline.
 *
 * This fragility caused the "UNKNOWN / Not linked" production symptom:
 * if any of those lookups silently failed (network, RLS, timeout), the
 * adapter_id resolved to null, and the UI rendered "UNKNOWN" /
 * "Not linked" for assets that were actually linked.
 *
 * THIS MODULE
 *
 *   resolveProviderSources(client, sourceIds?)
 *     → fetches streaming_sources + streaming_providers in two explicit
 *       queries (NO nested PostgREST join — that was the original
 *       fragility), joins them in app code, and returns a Map keyed by
 *       source ID. NEVER filters by enabled — disabled providers/sources
 *       may still have linked assets and must be resolvable.
 *
 *   resolveHostingSources(client)
 *     → convenience wrapper that returns the list shape the admin UI
 *       components consume ({ id, name, providerId, providerName,
 *       adapterId }). Used by the library + upload page servers.
 *
 *   resolveAdapterForAsset(client, mediaAsset)
 *     → single-asset resolver used by upload/complete/status/management
 *       services. Returns { adapterId, adapter } or throws
 *       ProviderResolutionError.
 *
 * ERROR SURFACING (FINDING-005 fix)
 *
 * None of these methods silently return an empty map on DB failure.
 * If a query fails, the error is captured in the result's `error`
 * field so the caller can surface it to the UI (instead of degrading
 * every adapter_id to null and rendering false "Not linked" states).
 *
 * SECURITY: server-side only. Uses the service-role admin client passed
 * by the caller. No credentials are exposed.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { getHostingAdapter } from './registry';
import type { HostingProviderAdapter } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A resolved provider source — the canonical shape consumed by all UIs. */
export type ResolvedProviderSource = {
  id: string;
  name: string;
  providerId: string | null;
  providerName: string | null;
  adapterId: string | null;
  /** Whether the provider is enabled (for display; never used for filtering). */
  providerEnabled: boolean | null;
  /** Whether the source is enabled (for display; never used for filtering). */
  sourceEnabled: boolean | null;
};

/** Result of resolveProviderSources / resolveHostingSources. */
export type ProviderResolutionResult = {
  /** Map of source ID → resolved source. Empty if no sources exist. */
  sources: Map<string, ResolvedProviderSource>;
  /** Flat list (convenience for UIs that don't need the Map). */
  list: ResolvedProviderSource[];
  /**
   * Non-null if EITHER query failed. The caller MUST surface this to the
   * UI instead of silently rendering "Not linked" for every asset.
   * Null means: queries succeeded (but the map may still be empty if no
   * sources are configured — that's a valid state, not an error).
   */
  error: { code: string; message: string } | null;
};

/** Single-asset resolution result. */
export type AssetAdapterResolution = {
  adapterId: string;
  adapter: HostingProviderAdapter;
  providerName: string | null;
  sourceName: string | null;
};

/**
 * Thrown when a single-asset provider resolution fails. Carries an
 * actionable code so the caller can surface it to the admin instead of
 * rendering "UNKNOWN".
 */
export class ProviderResolutionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProviderResolutionError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Bulk resolver — used by page servers (library, upload) and any UI that
// needs to resolve many source IDs at once.
// ---------------------------------------------------------------------------

/**
 * Resolve provider metadata for a set of streaming_source IDs.
 *
 * If `sourceIds` is omitted, resolves ALL sources (used by the library
 * page server to populate the hostingSources list).
 *
 * NEVER filters by `enabled`. Disabled providers/sources may still have
 * linked media_assets and MUST be resolvable so the UI can show their
 * real provider name instead of "UNKNOWN".
 *
 * Returns a result object with `sources` (Map), `list` (array), and
 * `error` (null on success, { code, message } on query failure).
 * The caller MUST check `error` and surface it to the UI — do NOT
 * silently degrade to "Not linked" states.
 */
export async function resolveProviderSources(
  client: SupabaseClient<Database>,
  sourceIds?: string[],
): Promise<ProviderResolutionResult> {
  // Two explicit queries, run in parallel. NO nested PostgREST join —
  // the nested `streaming_providers!inner(adapter_id)` syntax was the
  // original fragility (relation cardinality made the result come back
  // as either an object or an array, dropping adapter_id to null).
  const [providersRes, sourcesRes] = await Promise.all([
    client
      .from('streaming_providers')
      .select('id, name, adapter_id, enabled'),
    client
      .from('streaming_sources')
      .select('id, name, provider_id, enabled'),
  ]);

  // Surface query failures explicitly. The caller MUST render the error
  // instead of silently showing "Not linked" for every asset.
  if (providersRes.error) {
    return {
      sources: new Map(),
      list: [],
      error: {
        code: 'PROVIDER_QUERY_FAILED',
        message: `Failed to load streaming providers: ${providersRes.error.message}`,
      },
    };
  }
  if (sourcesRes.error) {
    return {
      sources: new Map(),
      list: [],
      error: {
        code: 'SOURCE_QUERY_FAILED',
        message: `Failed to load streaming sources: ${sourcesRes.error.message}`,
      },
    };
  }

  const providers = providersRes.data ?? [];
  const sources = sourcesRes.data ?? [];

  // Index providers by id for O(1) lookup.
  const providerById = new Map<string, (typeof providers)[number]>();
  for (const p of providers) {
    providerById.set(p.id, p);
  }

  // Optionally filter sources by the requested IDs.
  const filteredSources = sourceIds
    ? sources.filter((s) => sourceIds.includes(s.id))
    : sources;

  // Join in app code.
  const list: ResolvedProviderSource[] = filteredSources.map((s) => {
    const provider = providerById.get(s.provider_id) ?? null;
    return {
      id: s.id,
      name: s.name,
      providerId: provider?.id ?? null,
      providerName: provider?.name ?? null,
      adapterId: provider?.adapter_id ?? null,
      providerEnabled: provider?.enabled ?? null,
      sourceEnabled: s.enabled ?? null,
    };
  });

  const sourcesMap = new Map<string, ResolvedProviderSource>();
  for (const item of list) {
    sourcesMap.set(item.id, item);
  }

  return { sources: sourcesMap, list, error: null };
}

/**
 * Convenience wrapper: resolve ALL hosting sources (providers +
 * sources), returning the flat list shape the admin UI components
 * consume. Used by the library + upload page servers.
 */
export async function resolveHostingSources(
  client: SupabaseClient<Database>,
): Promise<ProviderResolutionResult> {
  return resolveProviderSources(client);
}

// ---------------------------------------------------------------------------
// Single-asset resolver — used by upload/complete/status/management
// services to resolve the adapter for one media_asset.
// ---------------------------------------------------------------------------

/**
 * Resolve the hosting adapter for a single provider_source_id.
 *
 * Throws ProviderResolutionError with an actionable code if:
 *   - the source row doesn't exist (NOT_FOUND)
 *   - the source's provider_id is null (SOURCE_HAS_NO_PROVIDER)
 *   - the provider row doesn't exist (PROVIDER_NOT_FOUND)
 *   - the provider has no adapter_id (PROVIDER_HAS_NO_ADAPTER)
 *   - no adapter is registered for the adapter_id (ADAPTER_NOT_REGISTERED)
 *
 * The caller should catch and surface the error code/message to the
 * admin UI. Never returns null — always throws on failure.
 */
export async function resolveAdapterForSource(
  client: SupabaseClient<Database>,
  providerSourceId: string,
): Promise<AssetAdapterResolution> {
  if (!providerSourceId) {
    throw new ProviderResolutionError('MISSING_SOURCE_ID', 'No provider source ID was provided.');
  }

  const { data: sourceRow, error: sourceError } = await client
    .from('streaming_sources')
    .select('id, name, provider_id')
    .eq('id', providerSourceId)
    .maybeSingle();

  if (sourceError) {
    throw new ProviderResolutionError(
      'SOURCE_QUERY_FAILED',
      `Failed to query streaming source: ${sourceError.message}`,
    );
  }
  if (!sourceRow) {
    throw new ProviderResolutionError(
      'SOURCE_NOT_FOUND',
      `Provider source ${providerSourceId} does not exist. It may have been deleted.`,
    );
  }
  if (!sourceRow.provider_id) {
    throw new ProviderResolutionError(
      'SOURCE_HAS_NO_PROVIDER',
      `Provider source ${sourceRow.name ?? providerSourceId} is not linked to a provider.`,
    );
  }

  const { data: providerRow, error: providerError } = await client
    .from('streaming_providers')
    .select('id, name, adapter_id')
    .eq('id', sourceRow.provider_id)
    .maybeSingle();

  if (providerError) {
    throw new ProviderResolutionError(
      'PROVIDER_QUERY_FAILED',
      `Failed to query streaming provider: ${providerError.message}`,
    );
  }
  if (!providerRow) {
    throw new ProviderResolutionError(
      'PROVIDER_NOT_FOUND',
      `Provider ${sourceRow.provider_id} (referenced by source ${sourceRow.name ?? providerSourceId}) does not exist.`,
    );
  }
  if (!providerRow.adapter_id) {
    throw new ProviderResolutionError(
      'PROVIDER_HAS_NO_ADAPTER',
      `Provider ${providerRow.name ?? providerRow.id} has no adapter_id configured.`,
    );
  }

  const adapter = getHostingAdapter(providerRow.adapter_id);
  if (!adapter) {
    throw new ProviderResolutionError(
      'ADAPTER_NOT_REGISTERED',
      `No hosting adapter is registered for adapter_id "${providerRow.adapter_id}".`,
    );
  }

  return {
    adapterId: providerRow.adapter_id,
    adapter,
    providerName: providerRow.name,
    sourceName: sourceRow.name,
  };
}

// ---------------------------------------------------------------------------
// Client-side helper — a pure function that components use to look up
// the adapterId for an asset from a pre-resolved hostingSources list.
// This replaces the duplicated adapterIdForSource() in 3 components.
// ---------------------------------------------------------------------------

/**
 * Look up the adapter ID for a provider_source_id from a pre-resolved
 * hosting sources list. Returns null if the source ID is not in the
 * list (e.g. the source was deleted, or the hostingSources query
 * failed and the list is empty).
 *
 * This is a PURE function — no DB access. The hostingSources list
 * must be passed in (typically from the page server's load function,
 * which calls resolveHostingSources()).
 *
 * Components should use this instead of inventing their own
 * `hostingSources.find(...)` logic.
 */
export function adapterIdForSource(
  hostingSources: ResolvedProviderSource[],
  sourceId: string | null | undefined,
): string | null {
  if (!sourceId) return null;
  return hostingSources.find((s) => s.id === sourceId)?.adapterId ?? null;
}

/**
 * Look up the source NAME for a provider_source_id. Returns null if
 * the source is not in the list (NOT 'Unknown' — the caller decides
 * what to render for an unknown source, e.g. a data-resolution error
 * banner rather than a misleading "UNKNOWN" label).
 */
export function sourceNameForId(
  hostingSources: ResolvedProviderSource[],
  sourceId: string | null | undefined,
): string | null {
  if (!sourceId) return null;
  return hostingSources.find((s) => s.id === sourceId)?.name ?? null;
}

/**
 * Look up the provider NAME for a provider_source_id. Returns null if
 * the source or provider is not in the list.
 */
export function providerNameForSource(
  hostingSources: ResolvedProviderSource[],
  sourceId: string | null | undefined,
): string | null {
  if (!sourceId) return null;
  return hostingSources.find((s) => s.id === sourceId)?.providerName ?? null;
}
