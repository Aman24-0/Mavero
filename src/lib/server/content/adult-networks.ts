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
// Follow-up production bug-fix task (2026-10-07, same redirect-slug
// verification method + show-page evidence): the user's production
// screenshots surfaced adult titles on Indian adult OTT networks that were
// NOT in the verified set, which is why `without_networks` and the central
// classifier could not see them. Four additional services are now
// live-verified (network/{id} -> {id}-{slug}; negative control re-run:
// network/999999999 -> 404):
//   ALTT           -> 2112  (https://www.themoviedb.org/network/2112-altbalaji;
//                            evidence: /tv/79273 "Gandii Baat" — the flagship
//                            ALTBalaji original — lists network 2112)
//   HotHit         -> 5094  (https://www.themoviedb.org/network/5094-hothit;
//                            evidence: /tv/119721 "Sweety Bhabhi" (production
//                            screenshot title) lists network 5094)
//   CinemaDosti    -> 4623  (https://www.themoviedb.org/network/4623-the-cinemadosti;
//                            evidence: /tv/122905 "Mohini Bhabhi" (production
//                            screenshot title) lists network 4623; the network
//                            page also lists /tv/120300 "Sunday" and
//                            /tv/120305 "Raat Baaki Baat Baaki")
//   NOTTY          -> 7905  (https://www.themoviedb.org/network/7905-notty;
//                            evidence: /tv/277729 "Bhabhi Ki Pathshala"
//                            (production screenshot title) lists network 7905)
//
// Follow-up adult-leak hardening task (2026-10-07, second round): the
// production leak audit proved the ecosystem is wider than the 7-network
// verified set. Five additional services are live-verified with the same
// redirect-slug method (+ show-page evidence; negative control re-run:
// network/999999999 -> 404):
//   Hulchul        -> 8209  (https://www.themoviedb.org/network/8209-hulchul;
//                            evidence: /tv/289516 "Gharwali Baharwali" lists
//                            network 8209; the leaked title "Bhabhi Ji Suniya
//                            Na" (/tv/290352, no network field on TMDB) is a
//                            Hulchul original — TMDB's own overview field
//                            says "New Hulchul WebSeries")
//   Nuefliks        -> 8211  (https://www.themoviedb.org/network/8211-nuefliks;
//                            evidence: /tv/119643 "Kotha" lists network 8211;
//                            the orphan title "Sarla Bhabhi" (/tv/129152) is
//                            externally documented as a Nuefliks/Flizmovies
//                            release — alias kept)
//   Rabbit Movies  -> 4575  (https://www.themoviedb.org/network/4575-rabbit;
//                            evidence: /tv/120642 "Mask Man" — a Rabbit
//                            Movies original — lists network 4575)
//   HotMasti       -> 5093  (https://www.themoviedb.org/network/5093-hot-masti;
//                            evidence: /tv/128528 "Deadly Lover" and
//                            /tv/128972 "Call Girl" list network 5093)
//   Big Movie Zoo  -> 4920  (https://www.themoviedb.org/network/4920-big-movie-zoo;
//                            evidence: /tv/125695 "Khoon Bhari Maang",
//                            /tv/125696, /tv/125699, /tv/128943 list network
//                            4920 — 4 networked titles total)
//
// Candidates AUDITED and REJECTED this round (no TMDB network identity or
// not verifiably an adult network — see the worklog for the full evidence):
//   PrimePlay, Hunters, Voovi, Primeshots, Boomex, TV Valentine,
//   Cinemadhamaka, Fuego  (no TMDB network entity exists to verify),
//   Bull  (TMDB search only finds Red Bull TV — unrelated),
//   Wow Entertainment  (no exact-name network on TMDB; the "wow" search
//   returns WOWOW Prime / Hot Entertainment / Bol Entertainment — all
//   unrelated),
//   Mohan Studios  (TMDB search resolves Mojang Studios — Minecraft, not
//   an adult service),
//   Vivamax (4569)  (Filipino mixed-content streaming service, not the
//   Indian erotic OTT ecosystem, and not uniformly adult — registering it
//   would over-block legitimate Filipino drama/thriller titles).
//
// ORPHAN TITLES: some Indian adult web-series entries on TMDB carry NO
// networks[] field at all (auto-scraped records). Those cannot be classified
// by ANY network registry. They are covered by the attribution registry in
// adult-orphans.ts (TMDB-recorded homepage/overview evidence + verified
// provider-catalog attribution) and by the classifier's homepage-domain /
// overview provider-context signals. Do NOT try to solve them here.
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
   * Official provider web domains (registrable-domain strings, lowercase,
   * no scheme — e.g. 'ullu.app'). Used ONLY by the classifier's homepage
   * signal: when a TMDB detail record's own `homepage` field points at one
   * of these domains, the title is provider-attributed adult content (the
   * attribution lives inside TMDB's own structured metadata — not a title
   * heuristic). Entries without a TMDB-recorded domain stay undefined —
   * domains are never guessed.
   * Verified domains (TMDB records carry them on network titles):
   *   ullu.app        — /tv/97072 "Charmsukh" homepage https://ullu.app/#/home
   *                     and /tv/219035 "Charmsukh Jane Anjane Mein"
   *                     homepage https://ullu.app/
   *   altbalaji.com   — /tv/79273 "Gandii Baat" homepage
   *                     https://www.altbalaji.com/show/307
   * Classification and catalog filters never read this field; it is a
   * detail-classification signal only.
   */
  providerDomains?: string[];
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
    // TMDB-recorded homepages: /tv/97072 "https://ullu.app/#/home",
    // /tv/219035 "https://ullu.app/" (2026-10-07 live check)
    providerDomains: ['ullu.app'],
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
  // --- Verified against live TMDB (2026-10-07 production bug-fix task;
  // redirect-slug method + show-page evidence, see header note). The
  // production screenshots proved these services leak into the normal TV
  // catalog when their networks are outside the verified set. ---
  {
    key: 'altt',
    name: 'ALTT',
    aliases: ['ALTBalaji'],
    // live TMDB: /network/2112 -> "2112-altbalaji" (evidence: /tv/79273
    // "Gandii Baat", the flagship ALTBalaji original, lists network 2112)
    tmdbNetworkId: 2112,
    // live TMDB network logo (2026-10-07; same live page that verified the id)
    tmdbLogoPath: '/zZ8gquIrrBvDGyMMcsSgArRuzyh.png',
    // TMDB-recorded homepage: /tv/79273 "Gandii Baat" homepage
    // https://www.altbalaji.com/show/307 (2026-10-07 live check)
    providerDomains: ['altbalaji.com'],
    verification: 'verified'
  },
  {
    key: 'hothit',
    name: 'HotHit',
    // live TMDB: /network/5094 -> "5094-hothit" (evidence: /tv/119721
    // "Sweety Bhabhi" — production screenshot title — lists network 5094)
    tmdbNetworkId: 5094,
    // live TMDB network logo (2026-10-07; same live page that verified the id)
    tmdbLogoPath: '/okM9V94bLu2BDyCkizxQN8ALRdy.png',
    verification: 'verified'
  },
  {
    key: 'cinemadosti',
    name: 'The CinemaDosti',
    aliases: ['CinemaDosti', 'Cinema Dosti'],
    // live TMDB: /network/4623 -> "4623-the-cinemadosti" (evidence:
    // /tv/122905 "Mohini Bhabhi" — production screenshot title — lists
    // network 4623; network page also lists "Sunday" and "Raat Baaki
    // Baat Baaki")
    tmdbNetworkId: 4623,
    // no logo on the live TMDB network page (checked 2026-10-07 — the page's
    // logo template renders ${data.logo_path} with an empty value) — the UI
    // renders the existing label-only fallback, never a fabricated logo
    verification: 'verified'
  },
  {
    key: 'notty',
    name: 'NOTTY',
    // live TMDB: /network/7905 -> "7905-notty" (evidence: /tv/277729
    // "Bhabhi Ki Pathshala" — production screenshot title — lists network 7905)
    tmdbNetworkId: 7905,
    // live TMDB network logo (2026-10-07; same live page that verified the id)
    tmdbLogoPath: '/rUT38Fm9TqUwxu4c1CVfC8VjFJ9.png',
    verification: 'verified'
  },
  // --- Verified against live TMDB (2026-10-07 second-round leak hardening;
  // redirect-slug method + show-page evidence, see header note). These five
  // close the remaining network coverage gaps behind the production leaks. ---
  {
    key: 'hulchul',
    name: 'Hulchul',
    // live TMDB: /network/8209 -> "8209-hulchul" (evidence: /tv/289516
    // "Gharwali Baharwali" lists network 8209; "Bhabhi Ji Suniya Na" — the
    // leaked screenshot title — is a Hulchul original whose TMDB overview
    // reads "New Hulchul WebSeries")
    tmdbNetworkId: 8209,
    // no logo on the live TMDB network page (checked 2026-10-07) — the UI
    // renders the existing label-only fallback, never a fabricated logo
    verification: 'verified'
  },
  {
    key: 'nuefliks',
    name: 'Nuefliks',
    aliases: ['Flizmovies'],
    // live TMDB: /network/8211 -> "8211-nuefliks" (evidence: /tv/119643
    // "Kotha" lists network 8211; orphan title "Sarla Bhabhi" /tv/129152 is
    // externally documented as a Nuefliks/Flizmovies release)
    tmdbNetworkId: 8211,
    // live TMDB network logo (2026-10-07; same live page that verified the id)
    tmdbLogoPath: '/zy10hodjaUiGp3BK4iJ6omo83qv.png',
    verification: 'verified'
  },
  {
    key: 'rabbit-movies',
    name: 'Rabbit Movies',
    aliases: ['Rabbit'],
    // live TMDB: /network/4575 -> "4575-rabbit" (evidence: /tv/120642
    // "Mask Man" — a Rabbit Movies original — lists network 4575)
    tmdbNetworkId: 4575,
    // live TMDB network logo (2026-10-07; same live page that verified the id)
    tmdbLogoPath: '/AdbQ6aK8kN0Q5Anj1EfB8jwCT5Y.png',
    verification: 'verified'
  },
  {
    key: 'hotmasti',
    name: 'HotMasti',
    // live TMDB: /network/5093 -> "5093-hot-masti" (evidence: /tv/128528
    // "Deadly Lover" and /tv/128972 "Call Girl" list network 5093)
    tmdbNetworkId: 5093,
    // live TMDB network logo (2026-10-07; same live page that verified the id)
    tmdbLogoPath: '/hgrQ2bj575Jis9Ri0N28d8T3Yiy.png',
    verification: 'verified'
  },
  {
    key: 'big-movie-zoo',
    name: 'Big Movie Zoo',
    // live TMDB: /network/4920 -> "4920-big-movie-zoo" (evidence:
    // /tv/125695 "Khoon Bhari Maang", /tv/125696, /tv/125699 and /tv/128943
    // list network 4920 — four networked titles)
    tmdbNetworkId: 4920,
    // live TMDB network logo (2026-10-07; same live page that verified the id)
    tmdbLogoPath: '/zIJoMv9FsH5rzqv479nSV2Ed45F.png',
    verification: 'verified'
  },
  // --- Candidates: known adult services, network IDs NOT yet confirmed ---
  // (names carried over from the legacy provider registry; IDs must be
  // live-confirmed before they may be set here — see header rules)
  { key: 'primeplay', name: 'PrimePlay', aliases: ['Prime Play'], tmdbNetworkId: 0, verification: 'unverified' },
  { key: 'hunters', name: 'Hunters', tmdbNetworkId: 0, verification: 'unverified' },
  { key: 'voovi', name: 'Voovi', tmdbNetworkId: 0, verification: 'unverified' },
  { key: 'cinemadhamaka', name: 'Cinemadhamaka', tmdbNetworkId: 0, verification: 'unverified' },
  { key: 'tv-valentine', name: 'TV Valentine', tmdbNetworkId: 0, verification: 'unverified' },
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
 * The subset of provider domains that may influence the classifier's
 * homepage signal: registrable domains of VERIFIED registry entries only
 * (unverified entries never carry domains; entries without TMDB-recorded
 * domain evidence carry none). Matched against the hostname of a TMDB
 * detail record's own `homepage` field — a structured TMDB field, never
 * free-text guessing.
 */
export function getVerifiedAdultProviderDomains(): string[] {
  return getVerifiedAdultNetworks().flatMap((entry) => entry.providerDomains ?? []);
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
