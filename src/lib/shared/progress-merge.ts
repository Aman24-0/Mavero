import { normalizeWatchlistStatus, type FavoriteRecord, type WatchProgressRecord, type CloudProgressRecord } from '$lib/client/progress/types';

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
