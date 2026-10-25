/**
 * Task 1 (2026-10-15) — Shared manual-link canonical identity orchestrator.
 *
 * Extracted from /api/admin/media/manual-link/+server.ts so the
 * parent-ensure-first contract is unit-testable without the SvelteKit
 * runtime (+server.ts files only allow route exports).
 *
 * PARENT-ENSURE-FIRST CONTRACT:
 * CanonicalMediaService's ensureEpisode/ensureAnimeEpisode are
 * single-level: they REQUIRE the parent series/anime row to already
 * exist and throw PARENT_NOT_FOUND otherwise. Every caller of this
 * orchestrator MUST guarantee the parent first with an idempotent
 * ensureSeries/ensureAnime upsert (the established convention in
 * missing/link +server.ts and upload/service.ts). The upsert's
 * onConflict canonical_key makes repeated saves converge on exactly
 * ONE parent row and keeps its title/year/poster metadata current.
 */
import type { CanonicalMediaService } from './service';
import { MediaServiceError } from './errors';

export type ResolveMediaItemArgs = {
  contentType: string;
  tmdbId: string;
  title: string;
  year: number | null;
  seasonNum: number | null;
  episodeNum: number | null;
  episodeTitle?: string | null;
  posterPath?: string | null;
  backdropPath?: string | null;
};

export async function resolveMediaItemId(
  mediaService: CanonicalMediaService,
  args: ResolveMediaItemArgs,
): Promise<string> {
  const { contentType, tmdbId, title, year, seasonNum, episodeNum, episodeTitle, posterPath, backdropPath } = args;

  // Validate season/episode as integers BEFORE calling ensure*, so
  // NaN strings don't surface as a confusing INVALID_SEASON error.
  const hasEpisode =
    seasonNum != null && Number.isInteger(seasonNum) &&
    episodeNum != null && Number.isInteger(episodeNum);

  // Defense-in-depth (mirrors the service's own validation contract):
  // reject invalid season/episode BEFORE the parent ensure so a failed
  // operation can never leave a partial canonical hierarchy. The service
  // allows season 0 (specials); negative seasons and non-positive
  // episodes are invalid. The endpoint additionally enforces positive
  // season+episode for series/anime (EPISODE_REQUIRED) before calling
  // this orchestrator.
  if (seasonNum != null && (!Number.isInteger(seasonNum) || seasonNum < 0)) {
    throw new MediaServiceError('INVALID_SEASON');
  }
  if (episodeNum != null && (!Number.isInteger(episodeNum) || episodeNum < 1)) {
    throw new MediaServiceError('INVALID_EPISODE');
  }

  if (contentType === 'movie') {
    return (await mediaService.ensureMovie({ tmdbId, title, year, posterPath, backdropPath })).mediaItemId;
  }
  if (contentType === 'anime') {
    // ensureAnimeEpisode requires the parent anime row (idempotent upsert
    // first — the established convention in missing/link + upload/service).
    await mediaService.ensureAnime({ tmdbId, title, year, posterPath, backdropPath });
    if (hasEpisode) {
      return (await mediaService.ensureAnimeEpisode({
        seriesTmdbId: tmdbId, season: seasonNum as number, episode: episodeNum as number, seriesTitle: title, episodeTitle: episodeTitle ?? null,
      })).mediaItemId;
    }
    return (await mediaService.ensureAnime({ tmdbId, title, year, posterPath, backdropPath })).mediaItemId;
  }
  // contentType === 'series' — same parent-first convention for regular TV.
  await mediaService.ensureSeries({ tmdbId, title, year, posterPath, backdropPath });
  if (hasEpisode) {
    return (await mediaService.ensureEpisode({
      seriesTmdbId: tmdbId, season: seasonNum as number, episode: episodeNum as number, seriesTitle: title, episodeTitle: episodeTitle ?? null,
    })).mediaItemId;
  }
  return (await mediaService.ensureSeries({ tmdbId, title, year, posterPath, backdropPath })).mediaItemId;
}
