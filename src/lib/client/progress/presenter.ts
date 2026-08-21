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

export function progressToMedia(record: WatchProgressRecord): MediaItem {
  const item = base(record.snapshot, record);
  const watchPath = record.season !== undefined && record.episode !== undefined ? `/watch/${record.contentType}/${record.contentId}/${record.season}/${record.episode}` : `/watch/${record.contentType}/${record.contentId}`;
  return { ...item, progress: progressPercent(record), progressLabel: progressLabel(record), resumeHref: watchPath, tags: ['Continue watching'] };
}

export function favoriteToMedia(record: FavoriteRecord): MediaItem {
  const status = record.status ?? 'planned';
  const item = base(record.snapshot, record);
  return { ...item, resumeHref: status === 'watching' ? `/watch/${record.contentType}/${record.contentId}` : undefined, tags: [status.charAt(0).toUpperCase() + status.slice(1)] };
}
