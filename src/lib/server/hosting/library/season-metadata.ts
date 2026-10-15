/**
 * (2026-10-15) — Season metadata source for the Media Library read model.
 *
 * Task 1 fix: the parent card's episode denominator ("1/28 linked") is
 * derived from the COMPLETE TMDB season/episode metadata — never from the
 * linked rows (local media_items rows only exist for episodes that were
 * linked at least once, which produced the "1/1 linked" bug).
 *
 * Contract rules:
 *   - The resolver returns NULL whenever the metadata cannot be trusted
 *     (fetch failure, no seasons, malformed payload). Callers then fall
 *     back to local counts and MUST NOT display a fabricated total —
 *     `metadata_available: false` tells the UI to render "N linked"
 *     without a denominator.
 *   - ONE bounded call per distinct series (the underlying TMDB detail
 *     path is cached + in-flight-deduplicated by the content layer, so
 *     repeated library loads reuse the same fetch — no N+1).
 *   - Season 0 (specials) is already excluded by the TMDB adapter's
 *     extractSeasonsData — the resolver does not re-filter it, but it
 *     tolerates a stray season 0 defensively.
 */

import { getDetail } from '$lib/server/content/service';

export type SeriesSeasonMetadata = {
  /** Distinct regular seasons (specials excluded upstream). */
  seasonCount: number;
  /** Sum of per-season episode counts = the series' TOTAL episodes. */
  episodeCount: number;
  /** Per-season episode counts, keyed by season number. */
  seasonEpisodeCounts: Map<number, number>;
};

export type SeasonMetadataResolver = (
  contentType: string,
  tmdbId: string,
) => Promise<SeriesSeasonMetadata | null>;

/**
 * Default resolver — the public content detail path (TMDB TV detail via
 * the cached getTmdbDetail; anime series are TMDB TV series too, so both
 * 'series' and 'anime' parents resolve through the same endpoint).
 * Returns null on ANY failure: the caller falls back to local counts.
 */
export const tmdbSeasonMetadataResolver: SeasonMetadataResolver = async (contentType, tmdbId) => {
  if (!/^\d{1,20}$/.test(tmdbId)) {
    // Non-numeric (fixture/dev) ids have no trusted season metadata.
    return null;
  }
  try {
    const detail = await getDetail('series', `series-${tmdbId}`);
    const seasonsData = (detail as { seasonsData?: Array<{ number?: number; episodeCount?: number; season_number?: number; episode_count?: number }> }).seasonsData;
    if (!Array.isArray(seasonsData) || seasonsData.length === 0) return null;
    const seasonEpisodeCounts = new Map<number, number>();
    let episodeCount = 0;
    for (const s of seasonsData) {
      const number = Number(s.number ?? s.season_number ?? NaN);
      const count = Number(s.episodeCount ?? s.episode_count ?? 0);
      if (!Number.isFinite(number) || number <= 0) continue; // skip specials/malformed
      if (!Number.isFinite(count) || count < 0) continue;
      seasonEpisodeCounts.set(number, count);
      episodeCount += count;
    }
    if (seasonEpisodeCounts.size === 0 || episodeCount <= 0) return null;
    return { seasonCount: seasonEpisodeCounts.size, episodeCount, seasonEpisodeCounts };
  } catch {
    // Unavailable metadata is NOT an error for the library read — the
    // caller renders the honest local-only count.
    return null;
  }
};

/**
 * Merge TMDB season metadata with the LOCAL linked-row rollup.
 *
 *   season_count    = union of metadata seasons and locally-seen seasons.
 *   episode_count   = metadata total + local episodes in seasons the
 *                     metadata does not know about (keeps linked<=total
 *                     even when the local catalog has extra seasons).
 *   metadata_available = whether the metadata totals were usable.
 */
export function mergeSeasonMetadata(
  local: { seasonCount: number; episodeCount: number; episodesBySeason: Map<number, number> },
  metadata: SeriesSeasonMetadata | null,
): { season_count: number; episode_count: number; metadata_available: boolean } {
  if (!metadata) {
    return {
      season_count: local.seasonCount,
      episode_count: local.episodeCount,
      metadata_available: false,
    };
  }
  // Local rows in seasons the metadata does not cover — counted exactly so
  // the total always includes every linked episode.
  let extraEpisodes = 0;
  const seasons = new Set<number>(metadata.seasonEpisodeCounts.keys());
  for (const [season, count] of local.episodesBySeason) {
    if (!metadata.seasonEpisodeCounts.has(season)) {
      extraEpisodes += count;
      seasons.add(season);
    }
  }
  return {
    season_count: Math.max(metadata.seasonCount, seasons.size),
    episode_count: metadata.episodeCount + extraEpisodes,
    metadata_available: true,
  };
}
