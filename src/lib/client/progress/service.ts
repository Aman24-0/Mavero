import { getFavorite, getLocalProgressState, getProgress, listFavorites, listProgress, putFavorite, putProgress, removeFavorite, removeProgress } from './database';
import { clampTime, completionFor, favoriteKey, normalizeWatchlistStatus, progressKey, type CloudProgressRecord, type ContentSnapshot, type FavoriteRecord, type LocalContentType, type PlaybackContext, type SaveProgressInput, type WatchProgressRecord, type WatchlistStatus } from './types';
import { listFavoriteDeletions, removeFavoriteDeletion, putFavoriteDeletion } from './database';
import { continueWatchingRecords, mergeProgress } from '../../shared/progress-merge';

export { mergeProgress } from '../../shared/progress-merge';

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
    sourceRuntimes: input.sourceRuntimes,
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
  const [progress, favorites] = await Promise.all([listProgress(), listFavorites()]);
  return continueWatchingRecords(progress, favorites);
}

export async function getLocalProgressRecords() {
  return listProgress();
}

export async function getRecentlyWatched(limit = 20) {
  return (await listProgress()).slice(0, limit);
}

export async function deleteProgress(context: PlaybackContext) {
  return removeProgress(context);
}

export async function saveFavorite(contentType: LocalContentType, contentId: string, snapshot: ContentSnapshot, now = Date.now(), status: WatchlistStatus = 'planned'): Promise<FavoriteRecord> {
  const existing = await getFavorite(contentType, contentId);
  await removeFavoriteDeletion(contentType, contentId);
  return putFavorite({ key: favoriteKey(contentType, contentId), contentType, contentId, snapshot, status: normalizeWatchlistStatus(status), createdAt: existing?.createdAt ?? now, updatedAt: now });
}

export async function setFavoriteStatus(contentType: LocalContentType, contentId: string, snapshot: ContentSnapshot, status: WatchlistStatus, now = Date.now()) {
  return saveFavorite(contentType, contentId, snapshot, now, status);
}

export async function toggleFavorite(contentType: LocalContentType, contentId: string, snapshot: ContentSnapshot) {
  const existing = await getFavorite(contentType, contentId);
  if (existing) {
    await removeFavoriteFromMyList(contentType, contentId);
    return { saved: false, status: undefined };
  }
  const record = await saveFavorite(contentType, contentId, snapshot);
  return { saved: true, status: record.status };
}

export async function getFavoritesByStatus(status?: WatchlistStatus) {
  const records = await listFavorites();
  return status ? records.filter((record) => normalizeWatchlistStatus(record.status) === status) : records;
}

export async function promoteProgressToWatching(progressRecords: WatchProgressRecord[]) {
  const [favorites, deletions] = await Promise.all([listFavorites(), listFavoriteDeletions()]);
  const deletedKeys = new Set(deletions.map((record) => record.key));
  const byKey = new Map<string, FavoriteRecord>();
  for (const record of favorites) byKey.set(record.key, { ...record, status: normalizeWatchlistStatus(record.status) });
  const inProgress = progressRecords.filter((record) => record.completionState !== 'completed' && record.currentTime > 0);
  for (const progress of inProgress) {
    const key = favoriteKey(progress.contentType, progress.contentId);
    if (deletedKeys.has(key)) continue;
    const existing = byKey.get(key);
    if (existing && normalizeWatchlistStatus(existing.status) === 'completed') continue;
    if (existing && normalizeWatchlistStatus(existing.status) === 'watching') continue;
    const saved = await saveFavorite(progress.contentType, progress.contentId, progress.snapshot, Date.now(), 'watching');
    byKey.set(key, saved);
  }
  return [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getLocalFavorites() {
  return listFavorites();
}

export async function isFavorite(contentType: LocalContentType, contentId: string) {
  return Boolean(await getFavorite(contentType, contentId));
}

export async function getFavoriteStatus(contentType: LocalContentType, contentId: string): Promise<WatchlistStatus | null> {
  const record = await getFavorite(contentType, contentId);
  return record ? normalizeWatchlistStatus(record.status) : null;
}

export async function removeFavoriteFromMyList(contentType: LocalContentType, contentId: string, deletedAt = Date.now()) {
  const key = favoriteKey(contentType, contentId);
  await removeFavorite(contentType, contentId);
  await putFavoriteDeletion({ key, contentType, contentId, deletedAt });
}

export async function deleteFavorite(contentType: LocalContentType, contentId: string) {
  return removeFavoriteFromMyList(contentType, contentId);
}

/** @deprecated Use removeFavoriteFromMyList. Kept as a safe compatibility alias; playback is never deleted. */
export async function deleteFavoriteAndProgress(contentType: LocalContentType, contentId: string) {
  return removeFavoriteFromMyList(contentType, contentId);
}

export async function getLocalPersistenceState() {
  return getLocalProgressState();
}

export function createProgressWriter(base: Omit<SaveProgressInput, 'currentTime' | 'duration'> & { initialCurrentTime?: number }, flushInterval = DEFAULT_FLUSH_INTERVAL) {
  let latest: SaveProgressInput | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  // Phase 9: per-source runtime map. Accumulated across source switches.
  let sourceRuntimes: Record<string, { duration: number; updatedAt: number }> = base.sourceRuntimes ? { ...base.sourceRuntimes } : {};
  // Phase 9 fix: initialize knownCurrentTime from existing progress so
  // updateRuntime() never resets it to 0 over an existing resume position.
  let knownCurrentTime = Math.max(0, Number.isFinite(base.initialCurrentTime) ? (base.initialCurrentTime ?? 0) : 0);

  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (disposed || !latest) return;
    const next = { ...latest, sourceRuntimes: { ...sourceRuntimes } };
    latest = undefined;
    await saveProgress(next);
  };

  const schedule = () => {
    if (timer || disposed) return;
    timer = setTimeout(() => { void flush(); }, flushInterval);
  };

  return {
    update(currentTime: number, duration?: number, completed = false) {
      // Phase 9 fix: track the latest known position.
      knownCurrentTime = currentTime;
      // Phase 9: update per-source runtime when duration is reported.
      if (duration && duration > 0 && base.selectedSourceId) {
        sourceRuntimes[base.selectedSourceId] = { duration, updatedAt: Date.now() };
      }
      latest = { ...base, currentTime, duration, completed, sourceRuntimes: { ...sourceRuntimes } };
      schedule();
    },
    // Phase 9 fix: update runtime independently from position updates.
    // NEVER resets currentTime to 0 — uses the known current position.
    updateRuntime(sourceId: string, duration: number) {
      if (disposed || !Number.isFinite(duration) || duration <= 0) return;
      sourceRuntimes[sourceId] = { duration, updatedAt: Date.now() };
      if (latest) {
        // Update the pending record's runtime map without changing position.
        latest.sourceRuntimes = { ...sourceRuntimes };
      } else {
        // Create a pending record using the KNOWN position, NOT 0.
        // This preserves existing progress when a duration event arrives
        // before the first timeupdate.
        latest = { ...base, currentTime: knownCurrentTime, sourceRuntimes: { ...sourceRuntimes } };
        schedule();
      }
    },
    pause() {
      return flush();
    },
    complete(currentTime: number, duration?: number) {
      knownCurrentTime = currentTime;
      latest = { ...base, currentTime, duration, completed: true, sourceRuntimes: { ...sourceRuntimes } };
      return flush();
    },
    flush,
    getSourceRuntimes() { return { ...sourceRuntimes }; },
    getKnownCurrentTime() { return knownCurrentTime; },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      latest = undefined;
    }
  };
}

// Phase 9: helper to get the runtime for a specific source from a progress record.
// Falls back to the record's top-level duration for backward compatibility.
export function getRuntimeForSource(record: WatchProgressRecord | undefined, sourceId: string | undefined): number {
  if (!record || !sourceId) return record?.duration ?? 0;
  if (record.sourceRuntimes && record.sourceRuntimes[sourceId]) {
    return record.sourceRuntimes[sourceId].duration;
  }
  // Backward compat: if no sourceRuntimes but the record has duration and selectedSourceId matches,
  // lazily use the top-level duration.
  if (record.selectedSourceId === sourceId && record.duration > 0) {
    return record.duration;
  }
  return record?.duration ?? 0;
}

export function progressLabel(record: WatchProgressRecord) {
  // Phase 9: use per-source runtime if available for the selected source.
  const effectiveDuration = getRuntimeForSource(record, record.selectedSourceId);
  const remaining = effectiveDuration > 0 ? Math.max(0, Math.round((effectiveDuration - record.currentTime) / 60)) : 0;
  const time = remaining > 0 ? `${remaining}m left` : 'Resume';
  if (record.contentType === 'movie') return time;
  if (record.season !== undefined && record.episode !== undefined) return `S${String(record.season).padStart(2, '0')} E${String(record.episode).padStart(2, '0')} · ${time}`;
  return time;
}

export function progressPercent(record: WatchProgressRecord) {
  const effectiveDuration = getRuntimeForSource(record, record.selectedSourceId);
  return effectiveDuration > 0 ? Math.min(100, Math.round((record.currentTime / effectiveDuration) * 100)) : 0;
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
