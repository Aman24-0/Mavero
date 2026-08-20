export type LocalContentType = 'movie' | 'series' | 'anime';
export type CompletionState = 'in_progress' | 'completed';

export type ContentSnapshot = {
  title: string;
  poster: string;
  backdrop?: string;
  year?: number;
  runtime?: string;
  rating?: number;
  genres?: string[];
  description?: string;
};

export type PlaybackContext = {
  contentType: LocalContentType;
  contentId: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
};

export type WatchProgressRecord = PlaybackContext & {
  key: string;
  currentTime: number;
  duration: number;
  completionState: CompletionState;
  selectedSourceId?: string;
  snapshot: ContentSnapshot;
  lastWatchedAt: number;
  updatedAt: number;
};

export type WatchlistStatus = 'watching' | 'planned' | 'completed';

export type FavoriteRecord = {
  key: string;
  contentType: LocalContentType;
  contentId: string;
  snapshot: ContentSnapshot;
  status?: WatchlistStatus;
  createdAt: number;
  updatedAt: number;
};

export function normalizeWatchlistStatus(value: unknown): WatchlistStatus {
  return value === 'watching' || value === 'completed' || value === 'planned' ? value : 'planned';
}

export type SaveProgressInput = PlaybackContext & {
  currentTime: number;
  duration?: number;
  selectedSourceId?: string;
  snapshot: ContentSnapshot;
  completed?: boolean;
  now?: number;
};

export type LocalStorageStatus = 'indexeddb' | 'memory' | 'unavailable';

export type LocalProgressState = {
  status: LocalStorageStatus;
  message?: string;
};

export type CloudProgressRecord = WatchProgressRecord;

export function progressKey(context: PlaybackContext) {
  return [context.contentType, context.contentId, context.season ?? '-', context.episode ?? '-'].join(':');
}

export function favoriteKey(contentType: LocalContentType, contentId: string) {
  return `${contentType}:${contentId}`;
}

export function completionFor(currentTime: number, duration: number, explicit = false): CompletionState {
  if (explicit) return 'completed';
  if (duration > 0 && currentTime / duration >= 0.9) return 'completed';
  return 'in_progress';
}

export function clampTime(currentTime: number, duration: number) {
  const safeCurrent = Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0;
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  return { currentTime: safeDuration ? Math.min(safeCurrent, safeDuration) : safeCurrent, duration: safeDuration };
}

export function isPlaybackRecord(value: unknown): value is WatchProgressRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<WatchProgressRecord>;
  return typeof record.key === 'string' && typeof record.contentId === 'string' && (record.contentType === 'movie' || record.contentType === 'series' || record.contentType === 'anime') && typeof record.currentTime === 'number' && typeof record.duration === 'number' && (record.completionState === 'in_progress' || record.completionState === 'completed') && typeof record.lastWatchedAt === 'number' && typeof record.updatedAt === 'number' && Boolean(record.snapshot && typeof record.snapshot === 'object');
}

export function isFavoriteRecord(value: unknown): value is FavoriteRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<FavoriteRecord>;
  return typeof record.key === 'string' && typeof record.contentId === 'string' && (record.contentType === 'movie' || record.contentType === 'series' || record.contentType === 'anime') && (record.status === undefined || record.status === 'watching' || record.status === 'planned' || record.status === 'completed') && typeof record.createdAt === 'number' && typeof record.updatedAt === 'number' && Boolean(record.snapshot && typeof record.snapshot === 'object');
}
