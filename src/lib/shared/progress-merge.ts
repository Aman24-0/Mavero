import { favoriteKey, normalizeWatchlistStatus, type FavoriteRecord, type WatchProgressRecord, type CloudProgressRecord } from '$lib/client/progress/types';

export function mergeProgress(local: WatchProgressRecord[], cloud: CloudProgressRecord[]) {
  const merged = new Map<string, WatchProgressRecord>();
  for (const record of [...local, ...cloud]) {
    const existing = merged.get(record.key);
    if (!existing || record.updatedAt > existing.updatedAt || (record.updatedAt === existing.updatedAt && record.currentTime > existing.currentTime)) merged.set(record.key, record);
  }
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function mergeFavorites(local: FavoriteRecord[], cloud: FavoriteRecord[]) {
  const merged = new Map<string, FavoriteRecord>();
  for (const rawRecord of [...local, ...cloud]) {
    const record = { ...rawRecord, status: normalizeWatchlistStatus(rawRecord.status) };
    const existing = merged.get(record.key);
    if (!existing || record.updatedAt > existing.updatedAt || (record.updatedAt === existing.updatedAt && record.createdAt < existing.createdAt)) merged.set(record.key, record);
  }
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function mergeFavoritesWithProgress(favorites: FavoriteRecord[], progress: WatchProgressRecord[]) {
  const merged = new Map(favorites.map((record) => [record.key, { ...record, status: normalizeWatchlistStatus(record.status) }]));
  for (const record of progress) {
    if (record.completionState === 'completed' || record.currentTime <= 0) continue;
    const key = favoriteKey(record.contentType, record.contentId);
    const existing = merged.get(key);
    if (existing && normalizeWatchlistStatus(existing.status) === 'completed') continue;
    const timestamp = Math.max(record.updatedAt, record.lastWatchedAt);
    merged.set(key, {
      key,
      contentType: record.contentType,
      contentId: record.contentId,
      snapshot: record.snapshot,
      status: 'watching',
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: Math.max(existing?.updatedAt ?? 0, timestamp),
    });
  }
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function continueWatchingRecords(progress: WatchProgressRecord[], favorites: FavoriteRecord[]) {
  const activeProgress = progress.filter((record) => record.completionState !== 'completed' && record.currentTime > 0);
  const progressKeys = new Set(activeProgress.map((record) => favoriteKey(record.contentType, record.contentId)));
  const manualWatching = favorites
    .filter((record) => normalizeWatchlistStatus(record.status) === 'watching' && !progressKeys.has(record.key))
    .map((record) => ({
      key: `${record.key}:watching`,
      contentType: record.contentType,
      contentId: record.contentId,
      currentTime: 0,
      duration: 0,
      completionState: 'in_progress' as const,
      snapshot: record.snapshot,
      lastWatchedAt: record.updatedAt,
      updatedAt: record.updatedAt,
    }));
  return [...activeProgress, ...manualWatching].sort((a, b) => b.lastWatchedAt - a.lastWatchedAt);
}
