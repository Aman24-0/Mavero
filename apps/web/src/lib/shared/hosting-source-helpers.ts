/**
 * Phase C (audit fix) — Pure client-safe helpers for provider source
 * resolution.
 *
 * These functions operate on a pre-resolved `hostingSources` list (the
 * flat array shape produced by the server-side
 * `resolveHostingSources()` in `$lib/server/hosting/provider-resolver`).
 * They contain NO server-only imports and are safe to use in `.svelte`
 * components.
 *
 * This module is the SINGLE SOURCE OF TRUTH for client-side
 * `adapterIdForSource()` / `sourceNameForId()` / `providerNameForSource()`
 * lookups. Previously these were duplicated in:
 *   - AdminMediaTable.svelte
 *   - AdminMediaCard.svelte
 *   - AdminMediaDetailDrawer.svelte
 *
 * All three duplicates have been replaced with imports from this module.
 *
 * The `ResolvedProviderSource` type is duplicated here (not imported
 * from the server module) so that client code doesn't pull in the
 * server-only `provider-resolver.ts` module via the type system. The
 * server module produces objects that structurally satisfy this type.
 */

/** Resolved provider source — client-safe shape (no server-only types). */
export type ResolvedProviderSource = {
  id: string;
  name: string;
  providerId: string | null;
  providerName: string | null;
  adapterId: string | null;
  providerEnabled?: boolean | null;
  sourceEnabled?: boolean | null;
};

/**
 * Minimal shape that the helper functions below actually require.
 * Accepts any array of objects with `id` + `adapterId` (+ optional
 * `name`, `providerName`). This lets the helpers be called with either
 * the full ResolvedProviderSource[] from the server resolver OR a
 * minimal subset from legacy component props (which only declare
 * `{ id, name, adapterId }`).
 */
export type HostingSourceLike = {
  id: string;
  name?: string | null;
  providerName?: string | null;
  adapterId?: string | null;
};

/**
 * Look up the adapter ID for a provider_source_id from a pre-resolved
 * hosting sources list. Returns null if the source ID is not in the
 * list (e.g. the source was deleted, or the hostingSources query
 * failed and the list is empty).
 *
 * Replaces the duplicated `adapterIdForSource()` in AdminMediaTable,
 * AdminMediaCard, and AdminMediaDetailDrawer.
 */
export function adapterIdForSource(
  hostingSources: HostingSourceLike[],
  sourceId: string | null | undefined,
): string | null {
  if (!sourceId) return null;
  return hostingSources.find((s) => s.id === sourceId)?.adapterId ?? null;
}

/**
 * Look up the source NAME for a provider_source_id. Returns null if
 * the source is not in the list.
 *
 * NOTE: returns null (NOT 'Unknown') so the caller can decide what to
 * render for an unknown source — e.g. a data-resolution error banner
 * rather than a misleading "UNKNOWN" label that looks like a real
 * provider name.
 */
export function sourceNameForId(
  hostingSources: HostingSourceLike[],
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
  hostingSources: HostingSourceLike[],
  sourceId: string | null | undefined,
): string | null {
  if (!sourceId) return null;
  return hostingSources.find((s) => s.id === sourceId)?.providerName ?? null;
}
