/**
 * Discover cross-rail deduplication.
 *
 * Ensures a title appears in ONE primary Discover location only.
 *
 * Section priority (highest first):
 *   1. theatre
 *   2. new-ott
 *   3. popular-movie / popular-series / popular-anime
 *   4. top-rated-movie / top-rated-series / top-rated-anime
 *   5. genre-* (each genre rail)
 *
 * Canonical identity: `${mediaType}:${tmdbId}` — e.g. "movie:550".
 * Movie and series with the same title are NOT merged.
 *
 * Main-genre assignment rule (deterministic):
 *   When a title belongs to multiple TMDB genres, it is assigned to
 *   exactly ONE genre rail based on the first matching genre in the
 *   GENRE_PRIORITY order below. This is deterministic — the same title
 *   always resolves to the same main genre.
 *
 *   GENRE_PRIORITY order:
 *     Action → Adventure → Crime → Thriller → Sci-Fi → Comedy → Drama → Horror → Romance
 *
 *   This order prioritizes "spectacle" genres (Action/Adventure/Crime)
 *   over "mood" genres (Comedy/Drama/Romance), because a title that
 *   is both Action and Comedy is more canonically "Action" in a
 *   streaming discovery context.
 */

import type { NormalizedMediaItem } from './types';

/**
 * Returns the canonical key for a media item: `${type}:${tmdbId}`.
 * Uses the TMDB numeric ID from externalIds when available, falling back
 * to the item's id field. Does NOT merge movie/series by title.
 *
 * Example: movie:550, series:1399
 * Movie and series with the same numeric TMDB ID remain distinct.
 */
export function canonicalKey(item: { type: string; id: string | number; externalIds?: { tmdb?: string } }): string {
  const tmdbId = item.externalIds?.tmdb;
  if (tmdbId) {
    return `${item.type}:${tmdbId}`;
  }
  // Fallback for items without externalIds — use the raw id.
  // This should be rare (mapTmdb always sets externalIds.tmdb).
  return `${item.type}:${item.id}`;
}

/** Section priority order — lower index = higher priority. */
export const SECTION_PRIORITY: readonly string[] = [
  'theatre',
  'new-ott',
  'popular-movie',
  'popular-series',
  'popular-anime',
  'top-rated-movie',
  'top-rated-series',
  'top-rated-anime',
  'genre-action',
  'genre-adventure',
  'genre-crime',
  'genre-thriller',
  'genre-scifi',
  'genre-comedy',
  'genre-drama',
  'genre-horror',
  'genre-romance',
];

/** Genre priority for canonical assignment (first match wins). */
export const GENRE_PRIORITY: readonly string[] = [
  'genre-action',
  'genre-adventure',
  'genre-crime',
  'genre-thriller',
  'genre-scifi',
  'genre-comedy',
  'genre-drama',
  'genre-horror',
  'genre-romance',
];

/** TMDB genre IDs mapped to section keys. */
const GENRE_ID_TO_SECTION: Record<number, string> = {
  28: 'genre-action',
  12: 'genre-adventure',
  80: 'genre-crime',
  53: 'genre-thriller',
  878: 'genre-scifi',
  35: 'genre-comedy',
  18: 'genre-drama',
  27: 'genre-horror',
  10749: 'genre-romance',
};

/** All genre section keys (for reverse lookup). */
const ALL_GENRE_SECTIONS = new Set(Object.values(GENRE_ID_TO_SECTION));

/**
 * Determines which genre section a title should be assigned to,
 * based on its TMDB genre IDs. Returns the first matching genre
 * in priority order, or null if none match.
 *
 * This is deterministic — the same genre IDs always produce the
 * same canonical genre section.
 */
export function canonicalGenreSection(genreIds: number[] | undefined | null): string | null {
  if (!genreIds || !Array.isArray(genreIds) || genreIds.length === 0) return null;
  for (const section of GENRE_PRIORITY) {
    // Find the TMDB genre ID for this section.
    const genreId = Object.entries(GENRE_ID_TO_SECTION).find(([, s]) => s === section)?.[0];
    if (genreId && genreIds.includes(Number(genreId))) {
      return section;
    }
  }
  return null;
}

/**
 * Result of a deduplicated rail fetch with continuation.
 */
export type DedupedRail = {
  section: string;
  items: NormalizedMediaItem[];
  page: number;
  hasNextPage: boolean;
};

/**
 * Filters items against a global seen set, returning only items
 * not already seen. Mutates the seen set to add newly included items.
 */
export function filterSeen(
  items: NormalizedMediaItem[],
  seen: Set<string>
): NormalizedMediaItem[] {
  const result: NormalizedMediaItem[] = [];
  for (const item of items) {
    const key = canonicalKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

/**
 * Determines whether a section is a genre section.
 */
export function isGenreSection(section: string): boolean {
  return ALL_GENRE_SECTIONS.has(section);
}

/**
 * Determines whether an item should be EXCLUDED from a genre section
 * because its canonical genre is a DIFFERENT genre section.
 *
 * This is used to prevent a title from appearing in every genre rail
 * it belongs to. A title is only shown in its canonical (first-priority)
 * genre rail, not in every genre it has.
 *
 * Uses the `tmdbGenreIds` field on NormalizedMediaItem (populated by
 * mapTmdb from raw.genre_ids or raw.genres[].id).
 */
export function shouldExcludeFromGenre(
  item: NormalizedMediaItem,
  targetGenreSection: string
): boolean {
  const canonical = canonicalGenreSection(item.tmdbGenreIds);
  if (canonical === null) return false; // No genre info — don't exclude
  return canonical !== targetGenreSection;
}
