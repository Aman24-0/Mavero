/**
 * MAV-FOCUSED — Phase 5 — Shared public route helpers (2026-10).
 *
 * Single source of truth for public detail + watch URL generation.
 * Replaces scattered string concatenation across components.
 *
 * Public route conventions (Phase 5):
 *
 *   Content type      Detail route              Watch route
 *   ──────────────────────────────────────────────────────────────────
 *   Movie             /movie/278                /watch/movie/278
 *   TV series         /tv-show/1396             /watch/tv-show/1396?season=1&episode=1
 *   Anime series      /anime-series/30984       /watch/anime-series/30984?season=1&episode=1
 *   Anime movie       /anime-movie/1311031      /watch/anime-movie/1311031
 *
 * Internal identity (unchanged):
 *   - media_items.canonical_key = 'movie:tmdb:278' / 'series:tmdb:1396' (DB)
 *   - NormalizedMediaItem.id = 'movie-278' / 'series-1396' (TMDB adapter)
 *   - Public route uses bare TMDB ID: 278, 1396, 30984, 1311031
 *
 * The public route type segment is distinct from the internal ContentType:
 *   - ContentType 'movie' → public route 'movie' OR 'anime-movie' (if isAnime + animeFormat='movie')
 *   - ContentType 'series' → public route 'tv-show'
 *   - ContentType 'anime'  → public route 'anime-series' (if animeFormat='series') OR 'anime-movie' (if animeFormat='movie')
 *
 * Legacy prefixed IDs (movie-278, series-1396, anime-30984) are accepted
 * by the detail routes for backward compatibility and redirected to the
 * bare-ID canonical form.
 */

/** Public route type segment (what appears in the URL path). */
export type PublicRouteType = 'movie' | 'tv-show' | 'anime-series' | 'anime-movie';

/** Internal content type (what the DB + TMDB adapter use). */
export type InternalContentType = 'movie' | 'series' | 'anime';

/**
 * Extract the bare TMDB ID from an item.id or route param.
 * Handles both bare IDs ('278') and prefixed IDs ('movie-278').
 * Returns null if the input doesn't contain a valid numeric TMDB ID.
 */
export function extractTmdbId(id: string): string | null {
  // Strip any known prefix (movie-, series-, anime-).
  const stripped = id.replace(/^(movie|series|anime)-/, '');
  // Validate as a positive integer.
  if (!/^\d{1,20}$/.test(stripped)) return null;
  return stripped;
}

/**
 * Determine the public route type from an item's internal type + anime flags.
 *
 * @param type — internal ContentType ('movie' | 'series' | 'anime')
 * @param isAnime — whether the title is classified as anime
 * @param animeFormat — 'movie' | 'series' | undefined
 * @returns the public route type segment
 */
export function publicRouteType(
  type: InternalContentType,
  isAnime?: boolean,
  animeFormat?: 'movie' | 'series' | undefined,
): PublicRouteType {
  // Anime movies (isAnime + animeFormat='movie') → /anime-movie/
  if (isAnime && animeFormat === 'movie') return 'anime-movie';
  // Anime series (isAnime + animeFormat='series', or type='anime') → /anime-series/
  if (isAnime && (animeFormat === 'series' || type === 'anime')) return 'anime-series';
  // Regular movies → /movie/
  if (type === 'movie') return 'movie';
  // Regular TV series → /tv-show/
  return 'tv-show';
}

/**
 * Generate the public detail route for a content item.
 *
 * @param id — item.id (e.g. 'movie-278', 'series-1396', 'anime-30984')
 * @param type — internal ContentType
 * @param isAnime — optional, from NormalizedMediaItem.isAnime
 * @param animeFormat — optional, from NormalizedMediaItem.animeFormat
 * @returns site-relative detail path (e.g. '/movie/278', '/tv-show/1396')
 */
export function detailHref(
  id: string,
  type: InternalContentType,
  isAnime?: boolean,
  animeFormat?: 'movie' | 'series' | undefined,
): string {
  const tmdbId = extractTmdbId(id);
  if (!tmdbId) return '/';
  const routeType = publicRouteType(type, isAnime, animeFormat);
  return `/${routeType}/${tmdbId}`;
}

/**
 * Generate the public watch (player) route for a content item.
 *
 * For episodic content (TV series, anime series), season + episode are
 * passed as query parameters (the canonical form). The legacy
 * /watch/[type]/[id]/[season]/[episode] path-form redirects to this.
 *
 * @param id — item.id (e.g. 'movie-278')
 * @param type — internal ContentType
 * @param isAnime — optional
 * @param animeFormat — optional
 * @param season — optional (for episodic content)
 * @param episode — optional (for episodic content)
 * @returns site-relative watch path (e.g. '/watch/movie/278', '/watch/tv-show/1396?season=1&episode=1')
 */
export function watchHref(
  id: string,
  type: InternalContentType,
  isAnime?: boolean,
  animeFormat?: 'movie' | 'series' | undefined,
  season?: number,
  episode?: number,
): string {
  const tmdbId = extractTmdbId(id);
  if (!tmdbId) return '/';
  const routeType = publicRouteType(type, isAnime, animeFormat);
  const base = `/watch/${routeType}/${tmdbId}`;
  // Episodic content: append season + episode as query params.
  if (routeType === 'tv-show' || routeType === 'anime-series') {
    const s = season ?? 1;
    const e = episode ?? 1;
    return `${base}?season=${s}&episode=${e}`;
  }
  return base;
}

/**
 * Convert a public route type segment back to the internal ContentType
 * for resolver / getDetail calls.
 *
 * 'movie' → 'movie'
 * 'tv-show' → 'series'
 * 'anime-series' → 'anime'
 * 'anime-movie' → 'movie' (anime movies use the movie TMDB endpoint,
 *                            distinguished by isAnime + animeFormat)
 */
export function internalContentType(routeType: PublicRouteType): InternalContentType {
  switch (routeType) {
    case 'movie': return 'movie';
    case 'tv-show': return 'series';
    case 'anime-series': return 'anime';
    case 'anime-movie': return 'movie';
  }
}

/**
 * Validate that a string is a valid public route type.
 */
export function isPublicRouteType(value: string | null | undefined): value is PublicRouteType {
  return value === 'movie' || value === 'tv-show' || value === 'anime-series' || value === 'anime-movie';
}

/**
 * Validate that a string is a valid bare TMDB ID (positive integer).
 */
export function isValidTmdbId(value: string | null | undefined): boolean {
  return Boolean(value && /^\d{1,20}$/.test(value));
}

/**
 * Check if an ID is in the legacy prefixed form (e.g. 'movie-278').
 * Used by detail routes to redirect legacy URLs to the canonical bare-ID form.
 */
export function isLegacyPrefixedId(id: string): boolean {
  return /^(movie|series|anime)-\d{1,20}$/.test(id);
}

/**
 * Check if a watch route type is a legacy type that needs redirecting.
 * Legacy: 'series' → 'tv-show', 'anime' → 'anime-series'.
 */
export function isLegacyWatchType(type: string): boolean {
  return type === 'series' || type === 'anime';
}

/**
 * Map a legacy watch type to the new public route type.
 * 'series' → 'tv-show'
 * 'anime' → 'anime-series'
 * 'movie' → 'movie' (unchanged)
 */
export function modernizeWatchType(type: string): PublicRouteType | null {
  if (type === 'movie') return 'movie';
  if (type === 'series') return 'tv-show';
  if (type === 'anime') return 'anime-series';
  return null;
}
