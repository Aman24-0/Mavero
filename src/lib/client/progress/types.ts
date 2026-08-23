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

export type FavoriteDeletionRecord = {
  key: string;
  contentType: LocalContentType;
  contentId: string;
  deletedAt: number;
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

const MAX_RECORD_KEY_LENGTH = 240;
const MAX_CONTENT_ID_LENGTH = 120;
const MAX_SNAPSHOT_TITLE_LENGTH = 240;
const MAX_SNAPSHOT_POSTER_LENGTH = 2_000;
const MAX_SNAPSHOT_DESCRIPTION_LENGTH = 4_000;
const MAX_SNAPSHOT_RUNTIME_LENGTH = 80;
const MAX_SNAPSHOT_GENRES = 20;
const MAX_SNAPSHOT_GENRE_LENGTH = 80;

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.trim().length > 0);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function isContentSnapshot(value: unknown): value is ContentSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Partial<ContentSnapshot>;
  return isBoundedString(snapshot.title, MAX_SNAPSHOT_TITLE_LENGTH)
    && isBoundedString(snapshot.poster, MAX_SNAPSHOT_POSTER_LENGTH, true)
    && (snapshot.backdrop === undefined || isBoundedString(snapshot.backdrop, MAX_SNAPSHOT_POSTER_LENGTH, true))
    && (snapshot.year === undefined || (Number.isSafeInteger(snapshot.year) && snapshot.year >= 1800 && snapshot.year <= 3000))
    && (snapshot.runtime === undefined || isBoundedString(snapshot.runtime, MAX_SNAPSHOT_RUNTIME_LENGTH, true))
    && (snapshot.rating === undefined || (typeof snapshot.rating === 'number' && Number.isFinite(snapshot.rating) && snapshot.rating >= 0 && snapshot.rating <= 10))
    && (snapshot.genres === undefined || (Array.isArray(snapshot.genres) && snapshot.genres.length <= MAX_SNAPSHOT_GENRES && snapshot.genres.every((genre) => isBoundedString(genre, MAX_SNAPSHOT_GENRE_LENGTH))))
    && (snapshot.description === undefined || isBoundedString(snapshot.description, MAX_SNAPSHOT_DESCRIPTION_LENGTH, true));
}

export function isPlaybackRecord(value: unknown): value is WatchProgressRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<WatchProgressRecord>;
  const validType = record.contentType === 'movie' || record.contentType === 'series' || record.contentType === 'anime';
  const season = record.season;
  const episode = record.episode;
  const validEpisodeContext = typeof season === 'number' && typeof episode === 'number' && Number.isSafeInteger(season) && Number.isSafeInteger(episode) && season > 0 && episode > 0;
  const validContext = record.contentType === 'movie'
    ? season === undefined && episode === undefined
    : (season === undefined && episode === undefined) || validEpisodeContext;
  return isBoundedString(record.key, MAX_RECORD_KEY_LENGTH)
    && isBoundedString(record.contentId, MAX_CONTENT_ID_LENGTH)
    && validType
    && validContext
    && record.key === progressKey(record as PlaybackContext)
    && typeof record.currentTime === 'number' && Number.isFinite(record.currentTime) && record.currentTime >= 0
    && typeof record.duration === 'number' && Number.isFinite(record.duration) && record.duration >= 0
    && (record.duration === 0 || record.currentTime <= record.duration)
    && (record.completionState === 'in_progress' || record.completionState === 'completed')
    && isFiniteTimestamp(record.lastWatchedAt)
    && isFiniteTimestamp(record.updatedAt)
    && isContentSnapshot(record.snapshot);
}

export function isFavoriteRecord(value: unknown): value is FavoriteRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<FavoriteRecord>;
  return isBoundedString(record.key, MAX_RECORD_KEY_LENGTH)
    && isBoundedString(record.contentId, MAX_CONTENT_ID_LENGTH)
    && (record.contentType === 'movie' || record.contentType === 'series' || record.contentType === 'anime')
    && record.key === favoriteKey(record.contentType, record.contentId)
    && (record.status === undefined || record.status === 'watching' || record.status === 'planned' || record.status === 'completed')
    && isFiniteTimestamp(record.createdAt)
    && isFiniteTimestamp(record.updatedAt)
    && isContentSnapshot(record.snapshot);
}

export function isFavoriteDeletionRecord(value: unknown): value is FavoriteDeletionRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<FavoriteDeletionRecord>;
  return isBoundedString(record.key, MAX_RECORD_KEY_LENGTH)
    && isBoundedString(record.contentId, MAX_CONTENT_ID_LENGTH)
    && (record.contentType === 'movie' || record.contentType === 'series' || record.contentType === 'anime')
    && record.key === favoriteKey(record.contentType, record.contentId)
    && isFiniteTimestamp(record.deletedAt);
}
