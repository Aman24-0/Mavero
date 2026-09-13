// Central adult TV NETWORK registry for the Adult Mode architecture rebuild.
//
// CANONICAL IDENTITY: TMDB TV NETWORK — not TMDB watch provider.
//
// Phase 1 (Mavero_Adult_Mode_Rebuild_Worklog.md, findings F1/F2) established
// that Indian adult OTT services such as Ullu, Kooku and Atrangii are
// represented by TMDB as TV NETWORKS (production/broadcast companies), not as
// JustWatch watch providers. Modelling them as watch providers is the root
// architecture bug of the old Adult Mode: `with_watch_providers` /
// `without_watch_providers` can neither serve the adult rail nor exclude
// adult-network originals from the normal catalog.
//
// This registry is the single source of truth for adult network identity.
// The central adult classifier (`isAdultContent` in adult-providers.ts) is the
// single consumer; future phases (3–8) build catalog queries, search,
// authorization and UI on top of it. Do NOT put adult network logic into UI
// files or TMDB adapter functions — extend THIS registry instead.
//
// VERIFICATION MODEL
// ==================
// Every entry carries an explicit `verification` label:
//
//   'verified'   — the tmdbNetworkId has been confirmed against live TMDB
//                  data (network page resolves to the expected network name;
//                  API-level JSON re-confirmation `/3/network/{id}` is repeated
//                  by the Phase 9 live diagnostic). Only verified entries with
//                  tmdbNetworkId > 0 may ever influence classification.
//   'unverified' — candidate service, NO trusted ID (tmdbNetworkId stays 0).
//                  Unverified entries are documentation/planning data only:
//                  they can NEVER become an active production filter through
//                  any accessor in this module (see getVerifiedAdultNetworks).
//
// Verified IDs currently in the registry (live TMDB check, 2026-09-07; method
// validated with positive control network/213 -> "213-netflix" and negative
// control network/999999999 -> 404):
//   Ullu     -> 2902  (https://www.themoviedb.org/network/2902-ullu)
//   Kooku    -> 4573  (https://www.themoviedb.org/network/4573-kooku)
//   Atrangii -> 7355  (https://www.themoviedb.org/network/7355-atrangii)
//
// RULES FOR FUTURE CHANGES
// ========================
// - Never add an ID that has not been confirmed against live TMDB data.
//   Do not substitute guessed watch-provider IDs either — watch-provider IDs
//   and TV-network IDs are different TMDB ID spaces.
// - To add a network: insert an entry with tmdbNetworkId: 0 and
//   verification: 'unverified', confirm the ID against live TMDB, then set
//   the ID and flip verification to 'verified' in the same change (with the
//   evidence date noted in the comment).
// - The registry is intentionally static data: no runtime fetches, no caches,
//   no clocks. Deterministic and credential-free.

export type AdultNetworkVerification = 'verified' | 'unverified';

export type AdultNetwork = {
  /** URL-safe key (same convention as the legacy provider registry). */
  key: string;
  /** Human-readable display name — matched against TMDB network names. */
  name: string;
  /** Alternate names to try for the defensive secondary name signal. */
  aliases?: string[];
  /**
   * TMDB TV network id. 0 = no verified id yet (entry is 'unverified').
   * This is a NETWORK id (TMDB /network/{id}), never a watch-provider id.
   */
  tmdbNetworkId: number;
  /**
   * TMDB network LOGO path (post-release fix — controlled logo mapping for
   * the authorized Adult provider dropdown). Static TMDB metadata captured
   * from the same live network pages that verified the IDs; served through
   * the SAME image CDN convention as provider logos
   * (https://image.tmdb.org/t/p/w92{path} via providerLogoUrl) — never an
   * arbitrary remote host. Optional and display-only: classification and
   * catalog filters never read it. Unverified entries carry no logo.
   */
  tmdbLogoPath?: string | null;
  /**
   * 'verified' requires BOTH a live-confirmed tmdbNetworkId > 0 and the
   * evidence note in the entry comment. Accessors in this module never
   * treat 'unverified' entries as active classification signals.
   */
  verification: AdultNetworkVerification;
};

/** Minimal shape of a TV network reference extracted from TMDB metadata. */
export type AdultNetworkRef = {
  id?: number | null;
  name?: string | null;
};

// Curated registry of Indian adult OTT services modelled as TMDB TV networks.
const ADULT_NETWORK_REGISTRY: AdultNetwork[] = [
  // --- Verified against live TMDB (2026-09-07, see header evidence note) ---
  // tmdbLogoPath values captured from the same live network pages (2026-09-08;
  // each confirmed to resolve on image.tmdb.org) — display metadata only.
  {
    key: 'ullu',
    name: 'Ullu',
    tmdbNetworkId: 2902, // live TMDB: /network/2902 -> "2902-ullu"
    tmdbLogoPath: '/v5YSGiZxWsQTRQaijkEcUSSBFeQ.png',
    verification: 'verified'
  },
  {
    key: 'kooku',
    name: 'Kooku',
    tmdbNetworkId: 4573, // live TMDB: /network/4573 -> "4573-kooku"
    tmdbLogoPath: '/aDbQUqZNtukLcX5LpOCTrKI2y5v.png',
    verification: 'verified'
  },
  {
    key: 'atrangii',
    name: 'Atrangii',
    tmdbNetworkId: 7355, // live TMDB: /network/7355 -> "7355-atrangii"
    tmdbLogoPath: '/qi6eRXHYSozqypShWsYpyWCWRJT.png',
    verification: 'verified'
  },
  // --- Candidates: known adult services, network IDs NOT yet confirmed ---
  // (names carried over from the legacy provider registry; IDs must be
  // live-confirmed before they may be set here — see header rules)
  { key: 'altt', name: 'ALTT', aliases: ['ALTBalaji'], tmdbNetworkId: 0, verification: 'unverified' },
  { key: 'rabbit-movies', name: 'Rabbit Movies', aliases: ['Rabbit'], tmdbNetworkId: 0, verification: 'unverified' },
  { key: 'nuefliks', name: 'Nuefliks', aliases: ['Flizmovies'], tmdbNetworkId: 0, verification: 'unverified' },
  { key: 'primeplay', name: 'PrimePlay', aliases: ['Prime Play'], tmdbNetworkId: 0, verification: 'unverified' },
  { key: 'hunters', name: 'Hunters', tmdbNetworkId: 0, verification: 'unverified' },
  { key: 'voovi', name: 'Voovi', tmdbNetworkId: 0, verification: 'unverified' },
  { key: 'big-movie-zoo', name: 'Big Movie Zoo', tmdbNetworkId: 0, verification: 'unverified' },
  { key: 'cinemadhamaka', name: 'Cinemadhamaka', tmdbNetworkId: 0, verification: 'unverified' },
  { key: 'tv-valentine', name: 'TV Valentine', tmdbNetworkId: 0, verification: 'unverified' },
  { key: 'hotmasti', name: 'HotMasti', tmdbNetworkId: 0, verification: 'unverified' },
  { key: 'mohan-studios', name: 'Mohan Studios', tmdbNetworkId: 0, verification: 'unverified' },
  { key: 'fuego', name: 'Fuego', tmdbNetworkId: 0, verification: 'unverified' }
];

// ---------------------------------------------------------------------------
// TEST-ONLY registry override.
// Lets behavioral tests install a controlled registry (deterministic,
// credential-free) without touching production data. NEVER call these from
// production code. Tests must reset the override when they are done.
// ---------------------------------------------------------------------------
let testRegistryOverride: AdultNetwork[] | null = null;

export function __setAdultNetworkRegistryForTest(entries: AdultNetwork[]): void {
  testRegistryOverride = entries;
}

export function __resetAdultNetworkRegistryForTest(): void {
  testRegistryOverride = null;
}

function activeRegistry(): AdultNetwork[] {
  return testRegistryOverride ?? ADULT_NETWORK_REGISTRY;
}

function normalizedNetworkName(name: string | null | undefined): string {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

function isVerifiedEntry(entry: AdultNetwork): boolean {
  return entry.verification === 'verified' && Number.isInteger(entry.tmdbNetworkId) && entry.tmdbNetworkId > 0;
}

/**
 * Full registry (verified AND unverified entries, with their verification
 * labels). Intended for admin/diagnostic/future-UI surfaces that need to
 * present candidate services. NOT for production filtering.
 */
export function getAdultNetworks(): AdultNetwork[] {
  return [...activeRegistry()];
}

/**
 * The subset of registry entries that may actively influence classification:
 * verification === 'verified' AND tmdbNetworkId > 0. Unverified entries are
 * structurally excluded here, so no caller can accidentally turn a guessed
 * or unconfirmed ID into a production filter.
 */
export function getVerifiedAdultNetworks(): AdultNetwork[] {
  return activeRegistry().filter(isVerifiedEntry);
}

/**
 * Verified adult network IDs — the production filter accessor.
 * Returns ONLY live-confirmed network IDs (never unverified/claimed IDs).
 * This is the list future catalog queries (with_networks / without_networks,
 * Phase 3) and search classification (Phase 4) must use.
 */
export function getAdultNetworkIds(): number[] {
  return getVerifiedAdultNetworks().map((entry) => entry.tmdbNetworkId);
}

/**
 * Registry lookup by TMDB network id (any verification state — the returned
 * entry carries its verification label so diagnostic callers can inspect it).
 * Returns undefined for ids <= 0 and for unknown ids.
 */
export function getAdultNetworkById(id: number): AdultNetwork | undefined {
  if (!Number.isInteger(id) || id <= 0) return undefined;
  return activeRegistry().find((entry) => entry.tmdbNetworkId === id);
}

/**
 * Display options for the authorized Adult provider dropdown (post-release
 * fix): VERIFIED networks only — unverified candidates are structurally
 * excluded, exactly like the classification accessors. Display metadata
 * (key/name/logo path) only; carrying a logo never widens filtering. Used
 * by the policy-gated provider list endpoint; the client maps these to the
 * closed-union `provider` values the Adult Discover API accepts.
 */
export function getVerifiedAdultNetworkOptions(): Array<{ key: string; name: string; logoPath: string | null }> {
  return getVerifiedAdultNetworks().map((entry) => ({ key: entry.key, name: entry.name, logoPath: entry.tmdbLogoPath ?? null }));
}

/**
 * Conservative match of a TMDB network reference against the VERIFIED adult
 * network set. Used by the central adult classifier.
 *
 * Matching order:
 *  1. Numeric TMDB network id (authoritative identity) — exact match against
 *     a verified entry's tmdbNetworkId.
 *  2. Defensive secondary name signal — exact (case-insensitive, trimmed)
 *     match of the network name against a verified entry's name/aliases.
 *     Substring matching is intentionally NOT used: "Ullu Originals" must not
 *     match "Ullu", mirroring the exact-match rule of the provider registry.
 *
 * Unverified registry entries never match — by id or by name.
 * Returns false for null/undefined input and for empty/partial references.
 */
export function isKnownAdultNetwork(network: AdultNetworkRef | null | undefined): boolean {
  if (!network) return false;
  const verified = getVerifiedAdultNetworks();
  if (verified.length === 0) return false;
  const id = typeof network.id === 'number' && Number.isInteger(network.id) && network.id > 0 ? network.id : null;
  if (id !== null && verified.some((entry) => entry.tmdbNetworkId === id)) return true;
  const name = normalizedNetworkName(network.name);
  if (!name) return false;
  return verified.some((entry) => {
    const candidates = [entry.name, ...(entry.aliases ?? [])].map(normalizedNetworkName).filter(Boolean);
    return candidates.includes(name);
  });
}
