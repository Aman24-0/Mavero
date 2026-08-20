import { getFavorite, getLocalProgressState, getProgress, listFavorites, listProgress, putFavorite, putProgress, removeFavorite, removeProgress } from './database';
import { clampTime, completionFor, favoriteKey, progressKey, type CloudProgressRecord, type ContentSnapshot, type FavoriteRecord, type LocalContentType, type PlaybackContext, type SaveProgressInput, type WatchProgressRecord } from './types';

export const COMPLETION_THRESHOLD = 0.9;
export const DEFAULT_FLUSH_INTERVAL = 12_000;

export async function saveProgress(input: SaveProgressInput): Promise<WatchProgressRecord> {
  const now = input.now ?? Date.now();
  const safe = clampTime(input.currentTime, input.duration ?? 0);
  const record: WatchProgressRecord = {
    key: progressKey(input),
    contentType: input.contentType,
    contentId: input.contentId,
    season: input.season,
    episode: input.episode,
    episodeTitle: input.episodeTitle,
    currentTime: safe.currentTime,
    duration: safe.duration,
    completionState: completionFor(safe.currentTime, safe.duration, input.completed),
    selectedSourceId: input.selectedSourceId,
    snapshot: input.snapshot,
    lastWatchedAt: now,
    updatedAt: now
  };
  return putProgress(record);
}

export async function getResumeProgress(context: PlaybackContext) {
  const record = await getProgress(context);
  if (!record) return { record: undefined, resumeTime: 0 };
  return { record, resumeTime: record.completionState === 'completed' ? 0 : record.currentTime };
}

export async function getContinueWatching() {
  const records = await listProgress();
  return records.filter((record) => record.completionState !== 'completed' && record.currentTime > 0).sort((a, b) => b.lastWatchedAt - a.lastWatchedAt);
}

export async function getRecentlyWatched(limit = 20) {
  return (await listProgress()).slice(0, limit);
}

export async function deleteProgress(context: PlaybackContext) {
  return removeProgress(context);
}

export async function saveFavorite(contentType: LocalContentType, contentId: string, snapshot: ContentSnapshot, now = Date.now()): Promise<FavoriteRecord> {
  const existing = await getFavorite(contentType, contentId);
  return putFavorite({ key: favoriteKey(contentType, contentId), contentType, contentId, snapshot, createdAt: existing?.createdAt ?? now, updatedAt: now });
}

export async function toggleFavorite(contentType: LocalContentType, contentId: string, snapshot: ContentSnapshot) {
  const existing = await getFavorite(contentType, contentId);
  if (existing) {
    await removeFavorite(contentType, contentId);
    return { saved: false };
  }
  await saveFavorite(contentType, contentId, snapshot);
  return { saved: true };
}

export async function getLocalFavorites() {
  return listFavorites();
}

export async function isFavorite(contentType: LocalContentType, contentId: string) {
  return Boolean(await getFavorite(contentType, contentId));
}

export async function getLocalPersistenceState() {
  return getLocalProgressState();
}

export function createProgressWriter(base: Omit<SaveProgressInput, 'currentTime' | 'duration'>, flushInterval = DEFAULT_FLUSH_INTERVAL) {
  let latest: SaveProgressInput | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (disposed || !latest) return;
    const next = latest;
    latest = undefined;
    await saveProgress(next);
  };

  const schedule = () => {
    if (timer || disposed) return;
    timer = setTimeout(() => { void flush(); }, flushInterval);
  };

  return {
    update(currentTime: number, duration?: number, completed = false) {
      latest = { ...base, currentTime, duration, completed };
      schedule();
    },
    pause() {
      return flush();
    },
    complete(currentTime: number, duration?: number) {
      latest = { ...base, currentTime, duration, completed: true };
      return flush();
    },
    flush,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      latest = undefined;
    }
  };
}

export function progressLabel(record: WatchProgressRecord) {
  const remaining = record.duration > 0 ? Math.max(0, Math.round((record.duration - record.currentTime) / 60)) : 0;
  const time = remaining > 0 ? `${remaining}m left` : 'Resume';
  if (record.contentType === 'movie') return time;
  if (record.season !== undefined && record.episode !== undefined) return `S${String(record.season).padStart(2, '0')} E${String(record.episode).padStart(2, '0')} · ${time}`;
  return time;
}

export function progressPercent(record: WatchProgressRecord) {
  return record.duration > 0 ? Math.min(100, Math.round((record.currentTime / record.duration) * 100)) : 0;
}

export function mergeProgress(local: WatchProgressRecord[], cloud: CloudProgressRecord[]) {
  const merged = new Map<string, WatchProgressRecord>();
  for (const record of [...local, ...cloud]) {
    const existing = merged.get(record.key);
    if (!existing || record.updatedAt > existing.updatedAt || (record.updatedAt === existing.updatedAt && record.currentTime > existing.currentTime)) merged.set(record.key, record);
  }
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export type FutureCloudProgressAdapter = {
  list(): Promise<CloudProgressRecord[]>;
  upsert(records: WatchProgressRecord[]): Promise<void>;
};

export async function mergeWithFutureCloud(adapter: FutureCloudProgressAdapter) {
  const local = await listProgress();
  const cloud = await adapter.list();
  const merged = mergeProgress(local, cloud);
  await Promise.all(merged.map(putProgress));
  await adapter.upsert(merged);
  return merged;
}
