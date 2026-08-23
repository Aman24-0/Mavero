import type { Json, Tables, TablesInsert } from './database.types';
import { favoriteKey, isContentSnapshot, normalizeWatchlistStatus, progressKey, type ContentSnapshot, type FavoriteDeletionRecord, type FavoriteRecord, type LocalContentType, type WatchProgressRecord } from '$lib/client/progress/types';

export type CloudHistoryEvent = {
  eventKey: string;
  eventType: 'started' | 'progressed' | 'completed';
  contentType: LocalContentType;
  contentId: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  currentTime: number;
  duration: number;
  completionState: 'in_progress' | 'completed';
  snapshot: ContentSnapshot;
  occurredAt: number;
};

const MAX_HISTORY_EVENT_KEY_LENGTH = 240;
const MAX_HISTORY_CONTENT_ID_LENGTH = 120;
const MAX_HISTORY_EPISODE_TITLE_LENGTH = 240;

export function isCloudHistoryEvent(value: unknown): value is CloudHistoryEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<CloudHistoryEvent>;
  const validType = event.contentType === 'movie' || event.contentType === 'series' || event.contentType === 'anime';
  const season = event.season;
  const episode = event.episode;
  const validEpisodeContext = typeof season === 'number' && typeof episode === 'number' && Number.isSafeInteger(season) && Number.isSafeInteger(episode) && season > 0 && episode > 0;
  const validContext = event.contentType === 'movie'
    ? season === undefined && episode === undefined
    : (season === undefined && episode === undefined) || validEpisodeContext;
  const validEventType = event.eventType === 'started' || event.eventType === 'progressed' || event.eventType === 'completed';
  const validCompletion = event.completionState === 'in_progress' || event.completionState === 'completed';
  const currentTime = event.currentTime;
  const duration = event.duration;
  const validNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  return typeof event.eventKey === 'string' && event.eventKey.trim().length > 0 && event.eventKey.length <= MAX_HISTORY_EVENT_KEY_LENGTH
    && validEventType
    && validType
    && typeof event.contentId === 'string' && event.contentId.trim().length > 0 && event.contentId.length <= MAX_HISTORY_CONTENT_ID_LENGTH
    && validContext
    && (event.episodeTitle === undefined || (typeof event.episodeTitle === 'string' && event.episodeTitle.length <= MAX_HISTORY_EPISODE_TITLE_LENGTH))
    && validNumber(currentTime)
    && validNumber(duration)
    && (duration === 0 || (typeof currentTime === 'number' && typeof duration === 'number' && currentTime <= duration))
    && validCompletion
    && isContentSnapshot(event.snapshot)
    && typeof event.occurredAt === 'number' && Number.isFinite(event.occurredAt) && event.occurredAt > 0;
}

function snapshotFromJson(value: Json): ContentSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { title: 'Untitled', poster: '' };
  const record = value as Record<string, Json | undefined>;
  return {
    title: typeof record.title === 'string' ? record.title : 'Untitled',
    poster: typeof record.poster === 'string' ? record.poster : '',
    backdrop: typeof record.backdrop === 'string' ? record.backdrop : undefined,
    year: typeof record.year === 'number' ? record.year : undefined,
    runtime: typeof record.runtime === 'string' ? record.runtime : undefined,
    rating: typeof record.rating === 'number' ? record.rating : undefined,
    genres: Array.isArray(record.genres) ? record.genres.filter((entry): entry is string => typeof entry === 'string') : undefined,
    description: typeof record.description === 'string' ? record.description : undefined,
  };
}

function contentType(value: string): LocalContentType {
  return value === 'series' || value === 'anime' ? value : 'movie';
}

export function progressFromRow(row: Tables<'watch_progress'>): WatchProgressRecord {
  return {
    key: row.progress_key,
    contentType: contentType(row.content_type),
    contentId: row.content_id,
    season: row.season ?? undefined,
    episode: row.episode ?? undefined,
    episodeTitle: row.episode_title ?? undefined,
    currentTime: row.position_seconds,
    duration: row.duration,
    completionState: row.completion_state as WatchProgressRecord['completionState'],
    selectedSourceId: row.selected_source_id ?? undefined,
    snapshot: snapshotFromJson(row.snapshot),
    lastWatchedAt: Date.parse(row.last_watched_at),
    updatedAt: Date.parse(row.updated_at),
  };
}

export function progressToRow(userId: string, record: WatchProgressRecord): TablesInsert<'watch_progress'> {
  return {
    user_id: userId,
    progress_key: progressKey(record),
    content_type: record.contentType,
    content_id: record.contentId,
    season: record.season ?? null,
    episode: record.episode ?? null,
    episode_title: record.episodeTitle ?? null,
    position_seconds: record.currentTime,
    duration: record.duration,
    completion_state: record.completionState,
    selected_source_id: record.selectedSourceId ?? null,
    snapshot: record.snapshot as unknown as Json,
    last_watched_at: new Date(record.lastWatchedAt).toISOString(),
    updated_at: new Date(record.updatedAt).toISOString(),
  };
}

export function favoriteFromRow(row: Tables<'favorites'>): FavoriteRecord {
  return {
    key: row.favorite_key,
    contentType: contentType(row.content_type),
    contentId: row.content_id,
    snapshot: snapshotFromJson(row.snapshot),
    status: normalizeWatchlistStatus(row.status),
    createdAt: Date.parse(row.created_at),
    updatedAt: Date.parse(row.updated_at),
  };
}

export function favoriteToRow(userId: string, record: FavoriteRecord): TablesInsert<'favorites'> {
  return {
    user_id: userId,
    favorite_key: favoriteKey(record.contentType, record.contentId),
    content_type: record.contentType,
    content_id: record.contentId,
    snapshot: record.snapshot as unknown as Json,
    status: normalizeWatchlistStatus(record.status),
    created_at: new Date(record.createdAt).toISOString(),
    updated_at: new Date(record.updatedAt).toISOString(),
  };
}

export function favoriteDeletionFromRow(row: Tables<'favorite_deletions'>): FavoriteDeletionRecord {
  return {
    key: row.favorite_key,
    contentType: contentType(row.content_type),
    contentId: row.content_id,
    deletedAt: Date.parse(row.deleted_at),
  };
}

export function favoriteDeletionToRow(userId: string, record: FavoriteDeletionRecord): TablesInsert<'favorite_deletions'> {
  return {
    user_id: userId,
    favorite_key: favoriteKey(record.contentType, record.contentId),
    content_type: record.contentType,
    content_id: record.contentId,
    deleted_at: new Date(record.deletedAt).toISOString(),
  };
}

export function historyFromRow(row: Tables<'watch_history'>): CloudHistoryEvent {
  return {
    eventKey: row.event_key,
    eventType: row.event_type as CloudHistoryEvent['eventType'],
    contentType: contentType(row.content_type),
    contentId: row.content_id,
    season: row.season ?? undefined,
    episode: row.episode ?? undefined,
    episodeTitle: row.episode_title ?? undefined,
    currentTime: row.position_seconds,
    duration: row.duration,
    completionState: row.completion_state as CloudHistoryEvent['completionState'],
    snapshot: snapshotFromJson(row.snapshot),
    occurredAt: Date.parse(row.occurred_at),
  };
}

export function historyToRow(userId: string, event: CloudHistoryEvent): TablesInsert<'watch_history'> {
  return {
    user_id: userId,
    event_key: event.eventKey,
    event_type: event.eventType,
    content_type: event.contentType,
    content_id: event.contentId,
    season: event.season ?? null,
    episode: event.episode ?? null,
    episode_title: event.episodeTitle ?? null,
    position_seconds: event.currentTime,
    duration: event.duration,
    completion_state: event.completionState,
    snapshot: event.snapshot as unknown as Json,
    occurred_at: new Date(event.occurredAt).toISOString(),
  };
}
