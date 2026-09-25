import type { MediaItem } from '$data/content';
import { progressLabel, progressPercent } from './service';
import type { FavoriteRecord, WatchProgressRecord } from './types';

function base(snapshot: WatchProgressRecord['snapshot'], record: { contentType: WatchProgressRecord['contentType']; contentId: string }): MediaItem {
  return {
    id: record.contentId,
    title: snapshot.title,
    year: snapshot.year ?? new Date().getFullYear(),
    type: record.contentType,
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

function watchPath(contentType: WatchProgressRecord['contentType'], contentId: string, season?: number, episode?: number) {
  const basePath = `/watch/${contentType}/${contentId}`;
  return season !== undefined && episode !== undefined ? `${basePath}?season=${season}&episode=${episode}` : basePath;
}

/**
 * P0: ONE canonical helper for finding the latest active progress record.
 *
 * Used by: DetailPage, favoriteToMedia, progressToMedia, Continue
 * Watching, My List, resumeHref generation, resume episode selection.
 *
 * Rules:
 *   - exact contentType + contentId match
 *   - completionState !== 'completed'
 *   - currentTime > 0 (true resumed playback, not just a zero-progress stub)
 *   - for series/anime: season and episode must be valid positive integers
 *
 * Ordering:
 *   1. latest max(updatedAt, lastWatchedAt) wins
 *   2. tie-break: higher currentTime wins (user watched further)
 *   3. never depends on array ordering
 *
 * For movies: returns the single active record (no season/episode requirement).
 * For series/anime: returns the latest active episode record.
 */
export function getLatestActiveProgress(
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
      r.currentTime > 0 &&
      (!isSeriesLike || (r.season !== undefined && r.episode !== undefined && r.season > 0 && r.episode > 0))
    )
    .sort((a, b) => {
      const aTime = Math.max(a.updatedAt, a.lastWatchedAt);
      const bTime = Math.max(b.updatedAt, b.lastWatchedAt);
      if (bTime !== aTime) return bTime - aTime;
      return b.currentTime - a.currentTime;
    })[0];
}

export function progressToMedia(record: WatchProgressRecord): MediaItem {
  const item = base(record.snapshot, record);
  const watchHref = watchPath(record.contentType, record.contentId, record.season, record.episode);
  return { ...item, progress: progressPercent(record), progressLabel: progressLabel(record), resumeHref: watchHref, tags: ['Continue watching'] };
}

export function favoriteToMedia(record: FavoriteRecord, progressRecords: WatchProgressRecord[] = []): MediaItem {
  const status = record.status ?? 'planned';
  const item = base(record.snapshot, record);
  // P0: use the canonical getLatestActiveProgress helper.
  const resume = status === 'watching' ? getLatestActiveProgress(record.contentType, record.contentId, progressRecords) : undefined;
  const isSeriesLike = record.contentType !== 'movie';
  const defaultEpisode = status === 'watching' && isSeriesLike ? { season: 1, episode: 1 } : undefined;
  const resumeHref = status === 'watching'
    ? watchPath(record.contentType, record.contentId, resume?.season ?? defaultEpisode?.season, resume?.episode ?? defaultEpisode?.episode)
    : undefined;
  const progressPct = resume ? progressPercent(resume) : undefined;
  const progressLbl = resume ? progressLabel(resume) : undefined;
  return { ...item, resumeHref, progress: progressPct, progressLabel: progressLbl, tags: [status.charAt(0).toUpperCase() + status.slice(1)] };
}

/**
 * P0: Thin wrapper over getLatestActiveProgress for callers that only need
 * the season/episode tuple (DetailPage, etc.). Uses the SAME canonical
 * algorithm — no duplicate filtering/sorting logic.
 */
export function latestResumeEpisode(
  contentType: WatchProgressRecord['contentType'],
  contentId: string,
  records: WatchProgressRecord[],
): { season: number; episode: number } | undefined {
  const record = getLatestActiveProgress(contentType, contentId, records);
  if (!record || record.season === undefined || record.episode === undefined) return undefined;
  return { season: record.season, episode: record.episode };
}
