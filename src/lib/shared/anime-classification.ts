/**
 * MAV-21 Workstream A — the ONE canonical anime classification contract.
 *
 * Mavero's established anime identity: a TMDB title is anime when it
 * carries the Animation genre (16) AND Japanese original_language
 * ('ja'). BOTH signals are required — genre alone must NEVER classify
 * a title as anime (western animation like Toy Story is genre 16 with
 * original_language 'en' and belongs to the ordinary Movie/TV Shows
 * catalogs), and language alone must never classify it either.
 *
 * Anime is INDEPENDENT of the movie/series dimension: an anime title
 * may be a movie (animeFormat 'movie') or a series (animeFormat
 * 'series'). The Anime category is the merged union of both formats;
 * the ordinary Movie and TV Shows categories exclude every title
 * classified as anime under this contract.
 *
 * This module is client-safe (pure, no server imports) and is the
 * single source of truth for:
 *   - `src/lib/server/content/adapters/tmdb.ts` (mapTmdb sets isAnime;
 *     the non-anime catalog surfaces post-filter rows with
 *     excludesAnimeRows — TMDB cannot express NOT(16 AND ja) at query
 *     level, and `without_genres=16` would wrongly evict western
 *     animation).
 *   - `src/lib/shared/upcoming-policy.ts` (isAnimeCandidate delegates
 *     here — the Upcoming Series pipeline REJECTS anime candidates
 *     with the same predicate).
 *   - the adult classifier's anime exemption.
 */

/** TMDB genre id for Animation. */
export const ANIME_GENRE_ID = 16;

/** TMDB original_language code for Japanese. */
export const ANIME_ORIGINAL_LANGUAGE = 'ja';

/**
 * Cache-key dimension for the anime-exclusion policy (MAV-21). Every
 * non-anime catalog query whose row set is now anime-excluded embeds
 * this constant in its cache key — the same re-keying discipline as
 * the Indian Popular-TV soap policy — so entries cached under the old
 * (anime-inclusive) semantics are never served after a policy change.
 */
export const ANIME_EXCLUSION_POLICY_KEY = 'aex1';

/**
 * The canonical anime predicate.
 *
 * Returns true ONLY when both authoritative signals are present
 * (Animation genre id AND Japanese original language). Missing or
 * incomplete metadata (no genre ids, no language) is NEVER anime —
 * the classification stays unknown rather than invented.
 */
export function isAnimeTitle(
  genreIds: number[] | undefined | null,
  originalLanguage: string | undefined | null
): boolean {
  return Array.isArray(genreIds) && genreIds.includes(ANIME_GENRE_ID) && originalLanguage === ANIME_ORIGINAL_LANGUAGE;
}
