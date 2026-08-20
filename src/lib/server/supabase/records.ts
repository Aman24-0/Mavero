import type { Json, Tables, TablesInsert } from './database.types';
import { favoriteKey, progressKey, type ContentSnapshot, type FavoriteRecord, type LocalContentType, type WatchProgressRecord } from '$lib/client/progress/types';

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
    created_at: new Date(record.createdAt).toISOString(),
    updated_at: new Date(record.updatedAt).toISOString(),
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
