// Adult ORPHAN-TITLE attribution registry (adult-leak hardening, 2026-10-07).
//
// WHY THIS EXISTS
// ===============
// A systematic live-TMDB audit of the Indian adult web-series ecosystem
// (Ullu / Kooku / Atrangii / ALTT / HotHit / CinemaDosti / NOTTY / Hulchul /
// Nuefliks / Rabbit / HotMasti / Big Movie Zoo ...) found that a portion of
// its TMDB entries are AUTO-SCRAPED RECORDS WITH NO `networks[]` FIELD, no
// production companies, no certifications, and frequently no keywords. TMDB's
// own `adult` flag on these entries is false (proven live: TMDB's public
// website search — which hides adult-flagged content, verified with positive
// controls "Debbie Does Dallas" / "Deep Throat" 1972-73 both hidden — returns
// these titles to anonymous visitors).
//
// Examples found by the audit (live 2026-10-07, https://www.themoviedb.org):
//   /tv/219035 "Charmsukh Jane Anjane Mein" — networks: none; keywords:
//     sex (267122) + nudity (281741); homepage: https://ullu.app/
//   /tv/290352 "Bhabhi Ji Suniya Na" — networks: none; keywords: none;
//     overview: "New Hulchul WebSeries"
//   /tv/212935 "Charmsukh Bidaai Part 1" — networks: none; keyword:
//     "charam sukh" (305434 — the Charmsukh franchise marker)
//   /tv/129152 "Sarla Bhabhi", /tv/128947 "Nancy Bhabhi",
//   /tv/208385 "Malkin Bhabhi", /tv/291951 "Raseeli Bhabhi",
//   /tv/226804 "Paglet" — networks: none; no distinguishing TMDB metadata
//
// NO network registry — however complete — can ever classify these entries,
// because the network field they would need IS the missing field. This
// registry is the bounded, evidence-recorded data-completion layer for that
// gap. It is NOT a title-keyword heuristic (no title-string matching ever
// happens) and NOT a lazy denylist: every entry is keyed by the canonical
// TMDB identity (media type + numeric id), is attributed to a provider
// (when the attribution is evidenced), and carries the recorded evidence
// that justified its inclusion. Entries were found by systematic ecosystem
// searches ("bhabhi", "charmsukh", "jane anjane", "palang tod", "paglet",
// "sauda", "khidki", ...), not by reacting to the leaked screenshot titles
// alone.
//
// EVIDENCE MODEL
// ==============
// Every entry records an evidence class:
//   'tmdb-homepage'     — the TMDB detail record's OWN homepage field points
//                         at a verified adult provider domain (structured
//                         TMDB metadata; the strongest orphan signal).
//   'tmdb-overview'     — the TMDB overview names the provider together with
//                         a web-series context (e.g. "New Hulchul WebSeries").
//   'franchise-parent'  — the title is part of an adult franchise whose
//                         parent series carries a verified adult network
//                         (e.g. the Charmsukh spin-offs under Ullu's
//                         /tv/97072 "Charmsukh").
//   'provider-catalog'  — external, recorded-attribution evidence: the title
//                         is documented (web search, 2026-10-07) as a release
//                         of a specific adult platform.
//   'external-adult-listing' — external documentation that the title is an
//                         adult (18+) web series, without a confirmed
//                         platform. Used ONLY where the adult nature is
//                         unambiguous; platform attribution stays undefined.
//
// CONSUMPTION
// ===========
// The central classifier (`isAdultContent` in adult-providers.ts) treats a
// registry match as an adult signal — exactly like a verified network match.
// The Adult Discover TV loader (adapters/tmdb.ts) additionally injects the
// attributed orphans of the selected provider into the provider-filtered
// catalog so the Adult surface shows the complete usable set, not just the
// subset TMDB happened to network-tag. Everything flows through the SAME
// central classification (a registry entry still passes the detail-path
// classifier, which confirms the attribution — defense-in-depth).
//
// RULES FOR FUTURE CHANGES
// ========================
// - Every entry MUST carry its evidence note. Never add an entry because of
//   its title text. Never add a speculative entry.
// - This registry is intentionally static, deterministic, credential-free:
//   no runtime fetches, no clocks, no caches.
// - Keep the registry SMALL: it is a data-completion layer for audited
//   ecosystem entries, not a parallel classification system. When TMDB grows
//   the network field for one of these entries, the network registry takes
//   over and the orphan entry becomes redundant (harmless — classification is
//   idempotent and dedup is by canonical identity).
// - The same test-only override convention as adult-networks.ts applies.

export type AdultOrphanEvidence =
  | 'tmdb-homepage'
  | 'tmdb-overview'
  | 'franchise-parent'
  | 'provider-catalog'
  | 'external-adult-listing';

export type AdultOrphanAttribution = {
  /** Canonical media type of the TMDB record. */
  mediaType: 'movie' | 'series';
  /** Canonical numeric TMDB id (the authoritative identity — never a title). */
  tmdbId: number;
  /**
   * Registry key of the attributed adult provider (an adult-networks.ts key).
   * undefined = adult nature externally documented but platform unconfirmed
   * (classification still applies; provider-scoped Adult Discover injection
   * does not — a title with no attributed provider never narrows a provider
   * query, and never widens one either).
   */
  providerKey?: string;
  /** Evidence class — see the header evidence model. */
  evidence: AdultOrphanEvidence;
  /** Human-readable evidence note (recorded at verification time). */
  note: string;
};

const ADULT_ORPHAN_REGISTRY: AdultOrphanAttribution[] = [
  {
    mediaType: 'series',
    tmdbId: 219035,
    providerKey: 'ullu',
    evidence: 'tmdb-homepage',
    note:
      'TMDB record homepage = https://ullu.app/ (live 2026-10-07). Ullu-original Charmsukh ' +
      'franchise entry; keywords sex (267122) + nudity (281741) on the same record. ' +
      'No networks[] field. This is one of the production-screenshot leaked titles.'
  },
  {
    mediaType: 'series',
    tmdbId: 290352,
    providerKey: 'hulchul',
    evidence: 'tmdb-overview',
    note:
      'TMDB overview reads "New Hulchul WebSeries" (live 2026-10-07) — the record itself ' +
      'names the Hulchul platform; externally confirmed as a Hulchul original web series ' +
      '(search evidence 2026-10-07). No networks[] field, no keywords, no homepage. This ' +
      'is one of the production-screenshot leaked titles.'
  },
  {
    mediaType: 'series',
    tmdbId: 212935,
    providerKey: 'ullu',
    evidence: 'franchise-parent',
    note:
      '"Charmsukh Bidaai Part 1" — a Charmsukh-franchise spin-off; the parent series ' +
      '/tv/97072 "Charmsukh" carries verified adult network Ullu 2902. The record carries ' +
      'the franchise keyword "charam sukh" (305434) and no networks[] field. External ' +
      'listings classify it as an 18+ web series (search evidence 2026-10-07).'
  },
  {
    mediaType: 'series',
    tmdbId: 129152,
    providerKey: 'nuefliks',
    evidence: 'provider-catalog',
    note:
      '"Sarla Bhabhi" — externally documented Nuefliks/Flizmovies hot web series (search ' +
      'evidence 2026-10-07: "SARLA BHABHI S01E02 – Hindi Hot Web Series – NueFliks"). ' +
      'No networks[] field on TMDB.'
  },
  {
    mediaType: 'series',
    tmdbId: 128947,
    providerKey: 'nuefliks',
    evidence: 'provider-catalog',
    note:
      '"Nancy Bhabhi" — externally documented Flizmovies (Nuefliks alias) release (search ' +
      'evidence 2026-10-07: "Nancy bhabhi s01e01 from flizmovies"). No networks[] field on ' +
      'TMDB; seasons 2020-2021 documented on IMDb/TMDB mirrors.'
  },
  {
    mediaType: 'series',
    tmdbId: 226804,
    providerKey: 'primeplay',
    evidence: 'provider-catalog',
    note:
      '"Paglet" (2023) — externally documented PrimePlay original (search evidence ' +
      '2026-10-07: "Paglet Primeplay Web Series (18+ Hot)", "Paglet Part 3 2022 Primeplay ' +
      'Originals"). PrimePlay has no TMDB network entity (audited — rejected), so the ' +
      'provider key points at the unverified candidate entry: classification applies, ' +
      'provider-scoped Adult Discover injection does not.'
  },
  {
    mediaType: 'series',
    tmdbId: 291951,
    providerKey: 'altt',
    evidence: 'provider-catalog',
    note:
      '"Raseeli Bhabhi" (2025) — externally documented ALTT App 18+ web series (search ' +
      'evidence 2026-10-07: "Raseeli Bhabhi 2025 Altt App Hindi XXX Web Series"). No ' +
      'networks[] field on TMDB.'
  },
  {
    mediaType: 'series',
    tmdbId: 208385,
    providerKey: undefined,
    evidence: 'external-adult-listing',
    note:
      '"Malkin Bhabhi" (2022, Hiral Radadiya) — externally documented Hindi adult (18+) ' +
      'web series (search evidence 2026-10-07: "adult web series" listings; the lead ' +
      'actress filmography is adult-OTT content). Platform attribution could NOT be ' +
      'confirmed, so no providerKey: adult classification applies, provider-scoped ' +
      'injection does not. No networks[] field on TMDB.'
  }
];

// ---------------------------------------------------------------------------
// TEST-ONLY registry override (same convention as adult-networks.ts).
// ---------------------------------------------------------------------------

let testRegistryOverride: AdultOrphanAttribution[] | null = null;

export function __setAdultOrphanRegistryForTest(entries: AdultOrphanAttribution[]): void {
  testRegistryOverride = entries;
}

export function __resetAdultOrphanRegistryForTest(): void {
  testRegistryOverride = null;
}

function activeRegistry(): AdultOrphanAttribution[] {
  return testRegistryOverride ?? ADULT_ORPHAN_REGISTRY;
}

function isRegistryEntryUsable(entry: AdultOrphanAttribution): boolean {
  return Number.isInteger(entry.tmdbId) && entry.tmdbId > 0 && (entry.mediaType === 'movie' || entry.mediaType === 'series');
}

/**
 * Full orphan registry (diagnostic access). Each entry carries its evidence
 * class + note so admin/diagnostic surfaces can present provenance.
 */
export function getAdultOrphanAttributions(): AdultOrphanAttribution[] {
  return activeRegistry().filter(isRegistryEntryUsable);
}

/**
 * Attribution lookup by canonical TMDB identity (media type + numeric id).
 * Returns the attribution when the identity is registered, else undefined.
 * This is the classifier's orphan signal (identity-keyed — titles are never
 * consulted).
 */
export function getAdultOrphanAttribution(
  mediaType: 'movie' | 'series' | undefined,
  tmdbId: number | undefined
): AdultOrphanAttribution | undefined {
  if (mediaType !== 'movie' && mediaType !== 'series') return undefined;
  if (!Number.isInteger(tmdbId) || (tmdbId as number) <= 0) return undefined;
  return activeRegistry().find(
    (entry) => isRegistryEntryUsable(entry) && entry.mediaType === mediaType && entry.tmdbId === tmdbId
  );
}

/**
 * Orphan identities attributed to a specific provider key, in registry order.
 * Used by the Adult Discover TV loader to inject a provider's orphan titles
 * into its provider-filtered catalog (the closed-union provider key is
 * validated by the route; only VERIFIED registry keys are selectable there,
 * so an attribution to an unverified candidate key simply never matches).
 * 'all' returns every attributed orphan.
 */
export function getAdultOrphanIdsForProvider(providerKey: string | undefined): Array<{ mediaType: 'movie' | 'series'; tmdbId: number }> {
  const usable = getAdultOrphanAttributions();
  if (!providerKey || providerKey === 'all') {
    return usable.map((entry) => ({ mediaType: entry.mediaType, tmdbId: entry.tmdbId }));
  }
  return usable
    .filter((entry) => entry.providerKey === providerKey)
    .map((entry) => ({ mediaType: entry.mediaType, tmdbId: entry.tmdbId }));
}
