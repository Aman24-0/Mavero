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

function latestActiveEpisode(record: FavoriteRecord, progressRecords: WatchProgressRecord[]) {
  return progressRecords
    .filter((progress) => progress.contentType === record.contentType && progress.contentId === record.contentId && progress.completionState !== 'completed' && progress.currentTime > 0 && progress.season !== undefined && progress.episode !== undefined)
    .sort((left, right) => Math.max(right.updatedAt, right.lastWatchedAt) - Math.max(left.updatedAt, left.lastWatchedAt))[0];
}

export function progressToMedia(record: WatchProgressRecord): MediaItem {
  const item = base(record.snapshot, record);
  const watchHref = watchPath(record.contentType, record.contentId, record.season, record.episode);
  return { ...item, progress: progressPercent(record), progressLabel: progressLabel(record), resumeHref: watchHref, tags: ['Continue watching'] };
}

export function favoriteToMedia(record: FavoriteRecord, progressRecords: WatchProgressRecord[] = []): MediaItem {
  const status = record.status ?? 'planned';
  const item = base(record.snapshot, record);
  const resume = status === 'watching' ? latestActiveEpisode(record, progressRecords) : undefined;
  const defaultEpisode = status === 'watching' && record.contentType !== 'movie' ? { season: 1, episode: 1 } : undefined;
  const resumeHref = status === 'watching'
    ? watchPath(record.contentType, record.contentId, resume?.season ?? defaultEpisode?.season, resume?.episode ?? defaultEpisode?.episode)
    : undefined;
  return { ...item, resumeHref, tags: [status.charAt(0).toUpperCase() + status.slice(1)] };
}

export function latestResumeEpisode(contentType: WatchProgressRecord['contentType'], contentId: string, progressRecords: WatchProgressRecord[]) {
  const progress = progressRecords
    .filter((record) => record.contentType === contentType && record.contentId === contentId && record.completionState !== 'completed' && record.currentTime > 0 && record.season !== undefined && record.episode !== undefined)
    .sort((left, right) => Math.max(right.updatedAt, right.lastWatchedAt) - Math.max(left.updatedAt, left.lastWatchedAt))[0];
  return progress ? { season: progress.season as number, episode: progress.episode as number } : undefined;
}
