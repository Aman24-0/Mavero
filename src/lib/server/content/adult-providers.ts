// Adult OTT provider registry for the Indian Adult Shows Discover section.
//
// ARCHITECTURE STATUS (Adult Mode rebuild, Phase 3):
// TRANSITIONAL — MOVIE-SIDE + DROPDOWN COMPATIBILITY ONLY.
//
// The canonical adult identity is the TMDB TV NETWORK registry in
// `adult-networks.ts` (Ullu=2902, Kooku=4573, Atrangii=7355, verified
// against live TMDB), consumed through `adult-catalog.ts` for catalog
// queries. Since Phase 3, NO TV catalog query depends on this module:
//   - normal TV rails exclude via `without_networks` (verified networks),
//   - the adult TV rail queries `with_networks`,
//   - TV detail classification uses the network signal first.
//
// THIS MODULE REMAINS because three surfaces still legitimately use the
// watch-provider model (all documented in the worklog Phase 3 section):
//   1. MOVIE catalog exclusion/inclusion — /discover/movie has NO network
//      filter in TMDB (movies carry companies, not networks), so the
//      movie halves of the normal rails and the adult rail keep the
//      watch-provider mechanism as a documented TRANSITIONAL defense.
//      Removed in Phase 7 (rail redesign) or when TMDB grows a
//      movie-side network/company equivalent.
//   2. The provider dropdown API (/api/discover/adult-providers) —
//      serves the verified provider list (with logos) for the existing
//      Adult section UI. UI/API redesign is Phase 7/8 scope.
//   3. MOVIE detail classification — the classifier's Signal 3 (below)
//      is the only non-flag adult signal available for movies.
//
// IMPORTANT (legacy behaviour, still true for provider IDs): we do NOT
// hardcode TMDB provider IDs. This registry stores provider NAMES that are
// matched at runtime against the live TMDB India provider list
// (getTmdbIndiaProviders()); names not found in the current TMDB India
// catalog are omitted from the dropdown and from classification.
//
// This module can never become the canonical adult identity again: TV
// catalog paths no longer call into it, and the network registry +
// adult-catalog.ts are the only sources of TV adult filtering.

import { isKnownAdultNetwork } from './adult-networks';

export type AdultOttProvider = {
  /** URL-safe key. */
  key: string;
  /** Human-readable display name — matched against TMDB provider names. */
  name: string;
  /** Alternate names to try if the primary name doesn't match. */
  aliases?: string[];
  /** Resolved TMDB provider_id (filled at runtime). 0 = not yet resolved / not found. */
  tmdbProviderId: number;
  /** Resolved TMDB logo path (filled at runtime). */
  logoPath: string | null;
};

// Curated list of known Indian adult-oriented OTT providers.
// The tmdbProviderId is ALWAYS 0 at startup and resolved at runtime.
// If a provider name is not found in TMDB's India provider list,
// it is excluded from the dropdown and from adult classification.
const ADULT_PROVIDER_REGISTRY: AdultOttProvider[] = [
  { key: 'ullu', name: 'Ullu', tmdbProviderId: 0, logoPath: null },
  { key: 'altt', name: 'ALTT', aliases: ['ALTBalaji'], tmdbProviderId: 0, logoPath: null },
  { key: 'rabbit-movies', name: 'Rabbit Movies', aliases: ['Rabbit'], tmdbProviderId: 0, logoPath: null },
  { key: 'atrangii', name: 'Atrangii', tmdbProviderId: 0, logoPath: null },
  { key: 'kooku', name: 'Kooku', tmdbProviderId: 0, logoPath: null },
  { key: 'nuefliks', name: 'Nuefliks', aliases: ['Flizmovies'], tmdbProviderId: 0, logoPath: null },
  { key: 'primeplay', name: 'PrimePlay', aliases: ['Prime Play'], tmdbProviderId: 0, logoPath: null },
  { key: 'hunters', name: 'Hunters', tmdbProviderId: 0, logoPath: null },
  { key: 'voovi', name: 'Voovi', tmdbProviderId: 0, logoPath: null },
  { key: 'big-movie-zoo', name: 'Big Movie Zoo', tmdbProviderId: 0, logoPath: null },
  { key: 'cinemadhamaka', name: 'Cinemadhamaka', tmdbProviderId: 0, logoPath: null },
  { key: 'tv-valentine', name: 'TV Valentine', tmdbProviderId: 0, logoPath: null },
  { key: 'hotmasti', name: 'HotMasti', tmdbProviderId: 0, logoPath: null },
  { key: 'mohan-studios', name: 'Mohan Studios', tmdbProviderId: 0, logoPath: null },
  { key: 'fuego', name: 'Fuego', tmdbProviderId: 0, logoPath: null },
];

// Runtime-resolved cache of verified adult provider IDs.
// Populated by resolveAdultProviders() on first access.
let resolvedProviders: AdultOttProvider[] | null = null;
let resolvedAt = 0;
const RESOLVE_TTL_MS = 300_000; // 5 min cache for the resolved provider list

/**
 * Resolve adult providers against the live TMDB India provider list.
 * Called by the TMDB adapter after fetching getTmdbIndiaProviders().
 *
 * This function receives the live TMDB India provider list and matches
 * adult provider names against it. Only providers that are actually
 * present in TMDB's India catalog are included in the result.
 *
 * @param indiaProviders - The live TMDB India provider list (from getTmdbIndiaProviders).
 * @returns The subset of adult providers that were verified against TMDB.
 */
export function resolveAdultProviders(
  indiaProviders: { providerId: number; name: string; logoPath: string | null; key: string }[]
): AdultOttProvider[] {
  const result: AdultOttProvider[] = [];
  for (const entry of ADULT_PROVIDER_REGISTRY) {
    // Match ONLY by exact name or explicitly configured alias.
    // No substring matching — "Rabbit" must NOT match "Rabbit Hole Studios".
    const namesToTry = [entry.name, ...(entry.aliases ?? [])].map((n) => n.toLowerCase().trim());
    const match = indiaProviders.find((p) => {
      const providerName = p.name.toLowerCase().trim();
      return namesToTry.includes(providerName);
    });
    if (match) {
      result.push({
        ...entry,
        tmdbProviderId: match.providerId,
        logoPath: match.logoPath,
      });
    }
    // If no match, the provider is simply omitted — we do NOT invent an ID.
  }
  resolvedProviders = result;
  resolvedAt = Date.now();
  return result;
}

/**
 * Get the cached resolved adult providers (if the cache is fresh).
 * Returns null if the cache is stale or empty — caller should call
 * resolveAdultProviders() first.
 */
export function getCachedAdultProviders(): AdultOttProvider[] | null {
  if (resolvedProviders && Date.now() - resolvedAt < RESOLVE_TTL_MS) {
    return resolvedProviders;
  }
  return null;
}

/**
 * Returns the list of verified adult provider IDs.
 * If the cache is stale or empty, this returns [] — the caller should
 * call ensureAdultProvidersResolved() first to guarantee the cache is
 * populated. This function is synchronous and never triggers a fetch.
 */
export function getAdultProviderIds(): number[] {
  const cached = getCachedAdultProviders();
  if (!cached) return [];
  return cached.map((p) => p.tmdbProviderId).filter((id) => id > 0);
}

/**
 * Ensure adult providers are resolved against the live TMDB India
 * provider list. If the cache is fresh, this is a no-op. If stale or
 * empty, it fetches the live TMDB India provider list (via the callback)
 * and resolves adult providers against it.
 *
 * This is the safe entry point that all adult-sensitive paths should
 * call before using getAdultProviderIds() or isAdultProvider().
 *
 * @param fetchIndiaProviders - A function that returns the live TMDB
 *   India provider list. This is passed as a callback to avoid a circular
 *   import dependency between adult-providers.ts and tmdb.ts.
 */
export async function ensureAdultProvidersResolved(
  fetchIndiaProviders: () => Promise<{ providerId: number; name: string; logoPath: string | null; key: string }[]>
): Promise<void> {
  const cached = getCachedAdultProviders();
  if (cached) return; // Cache is fresh.
  // Fetch the live TMDB India provider list and resolve adult providers.
  const indiaProviders = await fetchIndiaProviders();
  resolveAdultProviders(indiaProviders);
}

/**
 * Check whether a TMDB provider ID is a known adult provider.
 * Must be called after resolveAdultProviders() has been called.
 * Returns false if the ID is not in the resolved adult provider set.
 */
export function isAdultProvider(providerId: number): boolean {
  const cached = getCachedAdultProviders();
  if (!cached) return false;
  return cached.some((p) => p.tmdbProviderId === providerId);
}

/**
 * Get the adult OTT provider list for the dropdown.
 * Returns only providers whose TMDB provider_id has been verified.
 */
export function getAdultOttProviders(): AdultOttProvider[] {
  const cached = getCachedAdultProviders();
  return cached ?? [];
}

/**
 * Invalidate the resolved adult provider cache.
 * Called when the TMDB India provider list is refreshed.
 */
export function invalidateAdultProviderCache(): void {
  resolvedProviders = null;
  resolvedAt = 0;
}

// ============================================================
// Central adult content classifier (SINGLE server-side classifier).
//
// A title is classified as adult if ANY of:
//   1. Its `tags` array includes 'Adult' (set by getTmdbAdultShows and the
//      detail classification below).
//   2. Its TV `networks[]` include a VERIFIED adult network
//      (adult-networks.ts — the authoritative identity signal). A verified
//      adult network classifies the title as adult EVEN WHEN TMDB's generic
//      `adult` boolean is false, which is the normal case for Indian adult
//      OTT originals.
//   3. TRANSITIONAL (movie-side): its India watch providers include a
//      known adult provider ID. Since the Phase 3 catalog migration this
//      signal matters only for MOVIES (TV identity is the network signal
//      above; /discover/movie has no network filter and movie details
//      carry no networks). Retained until the Phase 7 movie-side
//      redesign; see the module header.
//   4. TMDB's `adult` boolean is true AND it's not anime.
//
// This function does NOT classify:
//   - anime (genre 16 + ja) as adult MERELY BECAUSE of TMDB's adult flag
//     (the anime exemption applies to signal 4 ONLY — explicit reliable
//     signals such as tags or a verified adult network still apply to any
//     content, anime included)
//   - mature-rated content as adult
//   - romance/violence as adult
//
// CLASSIFICATION vs AUTHORIZATION: this is a pure content-classification
// function. It takes NO user/authorization input, performs no I/O, and its
// result is global content metadata (safe to cache independently).
// Authorization (adult policy + user preference) is evaluated separately in
// adult-policy.ts and must NEVER be embedded into cached classification
// results.
//
// FAIL-CLOSED CONTRACT for future authorization paths (Phase 4+): a `false`
// return means "no positive adult signal in the provided metadata". Callers
// that fetch adult-sensitive metadata (e.g. search detail lookups) MUST
// treat a failed/incomplete metadata fetch as classification-uncertain and
// fail CLOSED (exclude the item), never silently allow it. Absence of
// signals in SUCCESSFULLY fetched metadata is a legitimate "not adult".
// ============================================================

/**
 * Classify whether a content item is adult.
 *
 * @param tags - The item's tags array (from NormalizedMediaItem.tags).
 * @param providerIds - Optional: the set of TMDB provider IDs available
 *   for this title in India. If provided, the function checks whether
 *   any of them are known adult providers (transitional signal).
 * @param tmdbAdult - Optional: TMDB's `adult` boolean flag. Only used
 *   as a secondary signal — never the sole classifier.
 * @param isAnime - Optional: if true, TMDB adult flag is ignored
 *   (anime should not be classified as adult based on TMDB's flag).
 * @param networks - Optional: the title's TMDB TV networks
 *   (NormalizedMediaItem.networks, from the TV detail response). A network
 *   matching a VERIFIED adult network classifies the title as adult even
 *   when tmdbAdult is false. Absent for movies and list-shaped results.
 * @returns true if the item is classified as adult.
 */
export function isAdultContent(
  tags: string[] | undefined,
  providerIds: number[] | undefined,
  tmdbAdult: boolean | undefined,
  isAnime: boolean | undefined,
  networks?: Array<{ id?: number | null; name?: string | null }> | undefined
): boolean {
  // Signal 1: explicit Adult tag (set by the adult section query and the
  // detail classification path).
  if (tags?.includes('Adult') === true) return true;

  // Signal 2 (authoritative): title belongs to a VERIFIED adult TV network.
  // Unverified registry entries cannot match — isKnownAdultNetwork only
  // consults the verified set (adult-networks.ts).
  if (networks && networks.length > 0) {
    for (const network of networks) {
      if (isKnownAdultNetwork(network)) return true;
    }
  }

  // Signal 3 (transitional): title is available on a known adult provider
  // in India. Retained until the Phase 3 network-based catalog migration.
  if (providerIds && providerIds.length > 0) {
    const cached = getCachedAdultProviders();
    if (cached && cached.length > 0) {
      for (const pid of providerIds) {
        if (cached.some((p) => p.tmdbProviderId === pid)) return true;
      }
    }
  }

  // Signal 4: TMDB's adult boolean — ONLY for non-anime content.
  // Anime can have adult=true in TMDB but should not be classified
  // as adult merely because of that flag (it may be mature anime
  // like Attack on Titan, which is not adult-provider content).
  if (tmdbAdult === true && isAnime !== true) return true;

  return false;
}
