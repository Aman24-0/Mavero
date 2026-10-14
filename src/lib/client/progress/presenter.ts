import type { MediaItem } from '$data/content';
import { progressLabel, progressPercent } from './service';
import type { FavoriteRecord, WatchProgressRecord } from './types';
import { watchHref as watchPath, extractTmdbId } from '$lib/shared/routes';

/**
 * Deep-audit Section 4 — deterministic classification reconstruction.
 *
 * The classification comes from the SNAPSHOT (written by the watch page /
 * favorite surfaces at save time — item.isAnime + item.animeFormat), with
 * a deterministic fallback for legacy records: an 'anime' contentType is
 * always an anime series (that is how the internal identity contract
 * defines it); a movie/series record without a snapshot flag keeps its
 * historical identity (we never GUESS anime from genre names).
 *
 * The output feeds straight into the shared route helpers, so an anime
 * movie renders /anime-movie/{tmdbId} + /watch/anime-movie/{tmdbId} and
 * an anime series renders /anime-series/{tmdbId} — exactly the same URLs
 * the rails/detail pages generate for the same title. This is the fix for
 * the owner-reported duplication (the same anime movie appearing as a
 * normal movie via Continue Watching while the anime rail linked it
 * canonically — the old private watchPath() below also emitted the legacy
 * prefixed /watch/movie/movie-1311031 form).
 */
function snapshotClassification(
  record: { contentType: WatchProgressRecord['contentType']; contentId: string },
  snapshot: WatchProgressRecord['snapshot'],
): { type: 'movie' | 'series' | 'anime'; isAnime: boolean; animeFormat: 'movie' | 'series' | undefined } {
  if (snapshot.isAnime === true) {
    const format = snapshot.animeFormat === 'movie' ? 'movie' : 'series';
    return { type: format === 'movie' ? 'movie' : 'anime', isAnime: true, animeFormat: format };
  }
  if (record.contentType === 'anime') {
    // Legacy record (no snapshot flag): an 'anime' contentType is by
    // definition an anime series in Mavero's internal identity contract.
    return { type: 'anime', isAnime: true, animeFormat: 'series' };
  }
  return { type: record.contentType, isAnime: false, animeFormat: undefined };
}

/**
 * Canonical watch URL via the SHARED route helper — with a legacy
 * construction fallback for ids that are NOT real TMDB ids (fixtures and
 * tests use slugs like 'sample-title'; the shared helper returns '/' for
 * those, while the historical behavior linked them directly).
 */
function canonicalWatchUrl(
  contentType: 'movie' | 'series' | 'anime',
  contentId: string,
  isAnime: boolean,
  animeFormat: 'movie' | 'series' | undefined,
  season?: number,
  episode?: number,
): string {
  if (extractTmdbId(contentId)) {
    return watchPath(contentId, contentType, isAnime, animeFormat, season, episode);
  }
  const basePath = `/watch/${contentType}/${contentId}`;
  return season !== undefined && episode !== undefined ? `${basePath}/${season}/${episode}` : basePath;
}
function base(snapshot: WatchProgressRecord['snapshot'], record: { contentType: WatchProgressRecord['contentType']; contentId: string }): MediaItem {
  const classification = snapshotClassification(record, snapshot);
  return {
    id: record.contentId,
    title: snapshot.title,
    year: snapshot.year ?? new Date().getFullYear(),
    type: classification.type,
    isAnime: classification.isAnime,
    animeFormat: classification.animeFormat,
    maturity: '13+',
    runtime: snapshot.runtime ?? 'Unknown runtime',
    rating: snapshot.rating ?? 0,
    genres: snapshot.genres ?? [],
    description: snapshot.description ?? '',
    poster: snapshot.poster,
    backdrop: snapshot.backdrop ?? snapshot.poster,
    accent: '#9b87f5'
  };
}

/**
 * P2: ONE canonical helper for finding the LATEST RESUME TARGET.
 *
 * A "resume target" is the episode/position the user should resume from.
 * This is DIFFERENT from "has actual playback progress" — a user can
 * click S2E3 and immediately leave before any provider emits a
 * timeupdate. S2E3 is STILL the resume target even with currentTime=0.
 *
 * Rules:
 *   - exact contentType + contentId match
 *   - completionState !== 'completed'
 *   - For MOVIES: currentTime > 0 (movies have no episode; a zero-progress
 *     movie record is not a meaningful resume target — use "Play" instead)
 *   - For SERIES/ANIME: valid season + episode (positive integers).
 *     currentTime MAY be 0 — the user selected this episode, that's enough.
 *
 * Ordering:
 *   1. latest max(updatedAt, lastWatchedAt) wins
 *   2. tie-break: higher currentTime wins (user watched further)
 *   3. never depends on array ordering
 */
export function getLatestResumeTarget(
  contentType: WatchProgressRecord['contentType'],
  contentId: string,
  records: WatchProgressRecord[],
): WatchProgressRecord | undefined {
  const isSeriesLike = contentType === 'series' || contentType === 'anime';
  return records
    .filter((r) =>
      r.contentType === contentType &&
      r.contentId === contentId &&
      r.completionState !== 'completed' &&
      (!isSeriesLike
        ? r.currentTime > 0  // movies: require actual playback
        : r.season !== undefined && r.episode !== undefined && r.season > 0 && r.episode > 0  // series: just need valid episode
      )
    )
    .sort((a, b) => {
      const aTime = Math.max(a.updatedAt, a.lastWatchedAt);
      const bTime = Math.max(b.updatedAt, b.lastWatchedAt);
      if (bTime !== aTime) return bTime - aTime;
      return b.currentTime - a.currentTime;
    })[0];
}

/**
 * Backward-compatible alias. getLatestActiveProgress now delegates to
 * getLatestResumeTarget. The old name is kept for any external callers.
 */
export function getLatestActiveProgress(
  contentType: WatchProgressRecord['contentType'],
  contentId: string,
  records: WatchProgressRecord[],
): WatchProgressRecord | undefined {
  return getLatestResumeTarget(contentType, contentId, records);
}

export function progressToMedia(record: WatchProgressRecord): MediaItem {
  const item = base(record.snapshot, record);
  // Canonical watch URL via the SHARED route helper (path-form season/
  // episode segments, bare TMDB ID, anime-aware route type). The resume
  // position carries season/episode only for episodic content.
  const classification = snapshotClassification(record, record.snapshot);
  const resumeHref = canonicalWatchUrl(classification.type, record.contentId, classification.isAnime, classification.animeFormat, record.season, record.episode);
  return { ...item, progress: progressPercent(record), progressLabel: progressLabel(record), resumeHref, tags: ['Continue watching'] };
}

export function favoriteToMedia(record: FavoriteRecord, progressRecords: WatchProgressRecord[] = []): MediaItem {
  const status = record.status ?? 'planned';
  const item = base(record.snapshot, record);
  // P8: use the canonical getLatestResumeTarget (not getLatestActiveProgress).
  // For series, this returns the latest episode even with currentTime=0.
  const resume = status === 'watching' ? getLatestResumeTarget(record.contentType, record.contentId, progressRecords) : undefined;
  const isSeriesLike = record.contentType !== 'movie';
  const defaultEpisode = status === 'watching' && isSeriesLike ? { season: 1, episode: 1 } : undefined;
  const classification = snapshotClassification(record, record.snapshot);
  const resumeHref = status === 'watching'
    ? canonicalWatchUrl(classification.type, record.contentId, classification.isAnime, classification.animeFormat, resume?.season ?? defaultEpisode?.season, resume?.episode ?? defaultEpisode?.episode)
    : undefined;
  // P14: only show progress bar / remaining time when the resume record
  // has ACTUAL playback data (currentTime > 0 + duration > 0).
  // A series resume target with currentTime=0 has NO progress — don't
  // fabricate 0% or a remaining-time label.
  const hasRealProgress = resume && resume.currentTime > 0 && resume.duration > 0;
  const progressPct = hasRealProgress ? progressPercent(resume) : undefined;
  const progressLbl = hasRealProgress ? progressLabel(resume) : undefined;
  return { ...item, resumeHref, progress: progressPct, progressLabel: progressLbl, tags: [status.charAt(0).toUpperCase() + status.slice(1)] };
}

/**
 * P0: Thin wrapper over getLatestResumeTarget for callers that only need
 * the season/episode tuple (DetailPage, etc.). Uses the SAME canonical
 * algorithm — no duplicate filtering/sorting logic.
 */
export function latestResumeEpisode(
  contentType: WatchProgressRecord['contentType'],
  contentId: string,
  records: WatchProgressRecord[],
): { season: number; episode: number } | undefined {
  const record = getLatestResumeTarget(contentType, contentId, records);
  if (!record || record.season === undefined || record.episode === undefined) return undefined;
  return { season: record.season, episode: record.episode };
}
