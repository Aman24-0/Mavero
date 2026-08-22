import type { MediaItem } from '$data/content';
import { progressLabel, progressPercent } from './service';
import type { FavoriteRecord, WatchProgressRecord } from './types';

function neutralImage(label: string, mode: 'poster' | 'backdrop') {
  const width = mode === 'poster' ? 720 : 1280;
  const height = mode === 'poster' ? 1080 : 720;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#171a24"/><circle cx="${width / 2}" cy="${height / 2 - 34}" r="42" fill="#8b5cf6" opacity=".2"/><path d="M${width / 2 - 18} ${height / 2 - 34}l36 0M${width / 2} ${height / 2 - 52}v36" stroke="#a78bfa" stroke-width="4" stroke-linecap="round"/><text x="50%" y="${height / 2 + 58}" text-anchor="middle" fill="#cbd5e1" font-family="Arial, sans-serif" font-size="22">${label.replace(/[<>&"']/g, '')}</text></svg>`)}`;
}

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
    poster: snapshot.poster || neutralImage(snapshot.title, 'poster'),
    backdrop: snapshot.backdrop || neutralImage(snapshot.title, 'backdrop'),
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
