// Adult OTT provider registry for the Indian Adult Shows Discover section.
//
// IMPORTANT: We do NOT hardcode TMDB provider IDs. TMDB IDs can change
// and we cannot verify them without a live API call. Instead, this
// registry stores provider NAMES that are known to be adult-oriented
// Indian streaming services. At runtime, the TMDB adapter's
// getTmdbIndiaProviders() is queried for the live India provider list;
// each adult provider name is matched against that list to resolve
// its real TMDB provider_id. If a provider is not found in the current
// TMDB India catalog, it is omitted from the dropdown and from the
// adult-content classification.
//
// Adult content classification: titles available on ANY verified adult
// provider are classified as adult and excluded from normal catalog rails
// (Popular, Top Rated, New on OTT, genre rails, search) regardless of
// Adult Mode setting. When Adult Mode is ON, these titles appear ONLY
// in the "Indian Adult Shows" section.
//
// The classification uses the provider-availability heuristic:
// if a title's watch providers include a known adult provider, it is
// treated as adult. This is more robust than TMDB's `adult` boolean
// (which is inconsistently set for Indian content).

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
    // Try primary name + aliases against the TMDB India provider list.
    // Match case-insensitively, trimming whitespace.
    const namesToTry = [entry.name, ...(entry.aliases ?? [])].map((n) => n.toLowerCase().trim());
    const match = indiaProviders.find((p) => {
      const providerName = p.name.toLowerCase().trim();
      return namesToTry.some((n) => providerName === n || providerName.includes(n) || n.includes(providerName));
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
 * Must be called after resolveAdultProviders() has been called at
 * least once with the live TMDB India provider list.
 * Returns an empty array if no providers have been resolved yet.
 */
export function getAdultProviderIds(): number[] {
  const cached = getCachedAdultProviders();
  if (!cached) return [];
  return cached.map((p) => p.tmdbProviderId).filter((id) => id > 0);
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
