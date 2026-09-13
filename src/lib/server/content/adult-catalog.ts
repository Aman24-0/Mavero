// Adult catalog query construction (Adult Mode architecture rebuild, Phase 3).
//
// This module is the BRIDGE between the central adult network registry
// (adult-networks.ts — the single source of truth for adult identity) and
// the TMDB catalog queries in adapters/tmdb.ts. It builds the TMDB
// discover filter fragments for network-based adult filtering:
//
//   - Normal TV catalog:  `without_networks=<verified adult network ids>`
//   - Adult TV catalog:   `with_networks=<verified adult network ids>`
//
// DESIGN RULES (binding):
// - IDs are ALWAYS obtained live from `getAdultNetworkIds()` — never
//   hardcoded here, never duplicated, never sourced from watch-provider
//   IDs. A repo-wide invariant test asserts this module contains no
//   literal network IDs.
// - Only VERIFIED registry entries can ever appear in a filter value.
//   `getAdultNetworkIds()` structurally excludes unverified entries, so
//   an unconfirmed network ID cannot reach a production query through
//   this module (proven by behavioral tests).
// - An empty verified registry produces an EMPTY param fragment (`{}`),
//   never a malformed value like `without_networks=` (proven by tests).
// - This module is pure and synchronous: no I/O, no env access, no
//   caches, no clocks. It carries NO authorization state — Adult Mode ON
//   or OFF never changes these values (normal rails exclude adult
//   networks regardless of the user; the adult rail includes them only
//   behind its own server-side authorization checks, which live in
//   service.discoverRail + the rail API, not here).
//
// TMDB SEPARATOR SEMANTICS: discover filters accept pipe-separated
// (OR / "any of") and comma-separated (AND / "all of") value lists. The
// adult filters need OR semantics — a title qualifies when it belongs to
// ANY verified adult network (with_networks), and is excluded when it
// belongs to ANY of them (without_networks) — so values are pipe-joined.
// This mirrors the existing with/without_watch_providers usage in this
// codebase (pipe-joined "any of" lists). The Phase 9 live TMDB diagnostic
// re-confirms both the separator semantics and the endpoint support
// matrix against the live API.
//
// ENDPOINT SUPPORT MATRIX (Phase 3 audit; re-confirmed in Phase 9):
// - /discover/tv      — supports with_networks + without_networks. ✔
// - /discover/movie   — NO network filter exists (movies carry production
//   companies, not networks). Movie-side adult filtering therefore stays
//   on the TRANSITIONAL watch-provider mechanism (adult-providers.ts) —
//   documented in the worklog; NOT silently kept.
// - /trending/*, /{movie,tv}/popular, /movie/now_playing, /search/*,
//   /{type}/{id}/recommendations — list/search endpoints support NO
//   network (or provider) filters. They are documented in the worklog as
//   requiring server-side classification (Phases 4/6) instead of
//   invented query parameters.

import { getAdultNetworkIds, getVerifiedAdultNetworks } from './adult-networks';

/** TMDB discover "any of" (OR) list separator. */
export const TMDB_NETWORK_OR_SEPARATOR = '|';

function sanitizeNetworkIds(ids: number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
}

/**
 * Pipe-joined "any of" value of the VERIFIED adult network IDs, or
 * undefined when the verified registry is empty. Sorted + deduped for
 * deterministic cache keys and queries. This is the single value-form
 * used by the TMDB adapter for both inclusion (adult rail) and
 * exclusion (normal TV rails).
 */
export function adultNetworkExclusionValue(): string | undefined {
  const ids = sanitizeNetworkIds(getAdultNetworkIds());
  return ids.length > 0 ? ids.join(TMDB_NETWORK_OR_SEPARATOR) : undefined;
}

/**
 * Param fragment excluding verified adult networks from a normal TV
 * catalog query. Returns `{}` (no parameter at all — never a malformed
 * empty value) when the verified registry is empty.
 */
export function withoutAdultNetworksParams(): { without_networks?: string } {
  const value = adultNetworkExclusionValue();
  return value ? { without_networks: value } : {};
}

/**
 * Param fragment including verified adult networks in the adult TV
 * catalog query. With `selectedNetworkId` (a user-selected service's
 * network) the filter narrows to that network — but ONLY if the id is
 * a VERIFIED registry entry; any other id (unknown, claimed, or
 * unverified) yields `{}` so an unconfirmed id can never reach a
 * production query through this module. Without a selection, all
 * verified networks are included (OR-joined). Returns `{}` when
 * nothing verified is available — the caller must skip the query
 * rather than send a malformed/empty filter.
 */
export function withAdultNetworksParams(selectedNetworkId?: number): { with_networks?: string } {
  if (selectedNetworkId !== undefined) {
    const isVerified = Number.isInteger(selectedNetworkId)
      && selectedNetworkId > 0
      && getVerifiedAdultNetworks().some((entry) => entry.tmdbNetworkId === selectedNetworkId);
    return isVerified ? { with_networks: String(selectedNetworkId) } : {};
  }
  const value = adultNetworkExclusionValue();
  return value ? { with_networks: value } : {};
}

/**
 * Resolve a user-selected service key (e.g. "ullu" from the adult rail
 * dropdown) to its VERIFIED TMDB network ID via the registry. Registry
 * keys intentionally match the legacy provider keys where the service is
 * the same. Returns undefined for unknown keys and for services whose
 * network ID is not verified yet (e.g. ALTT) — callers must treat that
 * as "no network filter available", never as "use the provider ID".
 */
export function getVerifiedAdultNetworkIdForKey(key: string | undefined): number | undefined {
  if (!key) return undefined;
  const match = getVerifiedAdultNetworks().find((entry) => entry.key === key);
  return match?.tmdbNetworkId;
}
