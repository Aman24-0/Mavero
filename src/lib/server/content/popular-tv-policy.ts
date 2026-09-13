// ============================================================
// INDIAN POPULAR TV — daily-soap curation policy (post-release fix phase).
//
// SCOPE (binding): this policy applies ONLY to the Discover "Popular TV
// shows" rail (`popular-series` -> getTmdbPopularByLanguage('series', ...)).
// It is NOT applied to:
//   - Popular Movies (getTmdbPopularByLanguage('movie', ...))
//   - Top Rated / Collection / New OTT / Theatre / genre rails
//   - Adult Discover (adult-catalog.ts + the Phase 7 contract)
//   - Search (search-classify.ts)
//   - Anime (getTmdbAnimeMerged — anime is never touched by this policy)
//
// WHY (root cause, live TMDB verification 2026-09-08):
//   The Phase 8 genre exclusion (POPULAR_TV_WITHOUT_GENRES = Soap 10764 /
//   News 10766 / Talk 10767) is applied correctly, but TMDB editors tag
//   Indian daily soaps with ONLY the Drama genre (18) — the Soap genre is
//   absent on every contaminating title measured:
//     Patiala Babes            /tv/85879  genres: 18 only   349 episodes
//     Vantalakka               /tv/235424 genres: 18 only   957 episodes
//     Pallakilo Pellikuturu    /tv/235330 genres: 18 only   198 episodes
//     Meenakshi Ponnunga       /tv/276583 genres: 18 only   637 episodes
//     Bhoomige Bandha Bhagyan. /tv/275535 genres: 18 only   354 episodes
//   Genre information alone is therefore INSUFFICIENT to separate them:
//   prestige Indian OTT shows carry the exact same tag (Rocket Boys
//   /tv/138211 is also Drama-only and MUST remain in the rail).
//
// THE RULE (reliable TMDB metadata, not a title blacklist):
//   Indian daily/weekly soaps are serials by production model — 5 new
//   episodes per week for years. The released-episode count is the one
//   structural TMDB field that separates the two populations with a huge
//   margin (measured: soaps 198-957 vs must-keep shows 10-32):
//
//     total released episodes > INDIAN_POPULAR_TV_DAILY_SOAP_MAX_EPISODES
//       => treated as a serial => excluded from the Popular TV rail.
//
//   This is deterministic metadata (TV detail `number_of_episodes`), it
//   never inspects titles, and it cannot damage limited/prestige TV: a
//   scripted OTT show would need 100+ RELEASED episodes before the rule
//   could even consider it.
//
// FAILURE SEMANTICS (deliberate asymmetry):
//   This is a CURATION filter, not a security boundary. A failed/missing
//   detail fetch keeps the candidate (fail-open for curation): degrading
//   to today's behavior (a soap may appear) is strictly better than
//   emptying the rail when TMDB hiccups. The ADULT exclusion is separate
//   and stays at the TMDB query level (`without_networks`) — untouched,
//   unconditional, fail-closed as built in the Adult Mode rebuild.
//
// CACHE KEYS (rule 13):
//   The applied policy is part of the Popular TV cache key via
//   INDIAN_POPULAR_TV_SOAP_POLICY_KEY, so a policy version bump re-keys
//   instead of serving stale-era entries. Movies carry the constant
//   'no-soap-policy' dimension (their query is unchanged).
// ============================================================

/**
 * A scripted series with MORE released episodes than this is treated as a
 * daily/weekly serial for the Popular TV rail. 100 sits far above every
 * measured must-keep Indian OTT show (max 32) and far below every measured
 * contaminating serial (min 198).
 */
export const INDIAN_POPULAR_TV_DAILY_SOAP_MAX_EPISODES = 100;

/**
 * Cache-key dimension representing the applied soap policy. Bump the
 * value (e.g. 'daily-soap-gt100' -> 'daily-soap-gt120') when the rule
 * changes so previously cached rails are never served under new policy
 * semantics.
 */
export const INDIAN_POPULAR_TV_SOAP_POLICY_KEY = 'daily-soap-gt100';

/** Cache-key dimension for the movie half (no soap policy in its scope). */
export const INDIAN_POPULAR_TV_NO_SOAP_POLICY_KEY = 'no-soap-policy';

/**
 * Bounded concurrency for the per-candidate episode-count lookups. The
 * lookups flow through the shared content-keyed `tmdb:detail:*` cache
 * (30 min TTL + stale-while-revalidate) that every rail classifier already
 * uses, so this only bounds the cold-cache burst — the same convention as
 * RAIL_CLASSIFY_CONCURRENCY / SEARCH_PAGE_SIZE classification.
 */
export const INDIAN_POPULAR_TV_SOAP_CHECK_CONCURRENCY = 4;

/**
 * Is this total released-episode count the signature of a daily/weekly
 * serial? Pure and synchronous. `undefined`/non-finite (missing metadata)
 * is NOT a soap — the candidate stays (fail-open for curation, see the
 * module header). Values exactly AT the threshold stay too; only strictly
 * greater counts are serials.
 */
export function isDailySoapEpisodeCount(totalEpisodes: number | undefined | null): boolean {
  if (typeof totalEpisodes !== 'number' || !Number.isFinite(totalEpisodes)) return false;
  return totalEpisodes > INDIAN_POPULAR_TV_DAILY_SOAP_MAX_EPISODES;
}
