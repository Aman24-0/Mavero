import { favoriteKey, normalizeWatchlistStatus, type FavoriteDeletionRecord, type FavoriteRecord, type WatchProgressRecord, type CloudProgressRecord, type SourceRuntimeEntry } from '$lib/client/progress/types';

// Phase 9: merge sourceRuntimes from both sides. For each source ID, prefer
// the entry with the newer updatedAt. This preserves runtimes from both
// local and cloud even if the record itself was chosen from one side.
function mergeSourceRuntimes(
  winner: WatchProgressRecord,
  loser: WatchProgressRecord | undefined,
): Record<string, SourceRuntimeEntry> | undefined {
  if (!loser?.sourceRuntimes) return winner.sourceRuntimes;
  if (!winner.sourceRuntimes) return loser.sourceRuntimes;
  const merged: Record<string, SourceRuntimeEntry> = { ...loser.sourceRuntimes };
  for (const [sourceId, entry] of Object.entries(winner.sourceRuntimes)) {
    const existing = merged[sourceId];
    if (!existing || entry.updatedAt >= existing.updatedAt) {
      merged[sourceId] = entry;
    }
  }
  return merged;
}

export function mergeProgress(local: WatchProgressRecord[], cloud: CloudProgressRecord[]) {
  const merged = new Map<string, WatchProgressRecord>();
  for (const record of [...local, ...cloud]) {
    const existing = merged.get(record.key);
    if (!existing) {
      merged.set(record.key, record);
    } else if (record.updatedAt > existing.updatedAt || (record.updatedAt === existing.updatedAt && record.currentTime > existing.currentTime)) {
      // Phase 9: merge sourceRuntimes from the losing record before replacing.
      const mergedRuntimes = mergeSourceRuntimes(record, existing);
      merged.set(record.key, { ...record, sourceRuntimes: mergedRuntimes });
    } else {
      // The existing record wins, but merge sourceRuntimes from the losing record.
      const mergedRuntimes = mergeSourceRuntimes(existing, record);
      merged.set(record.key, { ...existing, sourceRuntimes: mergedRuntimes });
    }
  }
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function mergeFavoriteDeletions(local: FavoriteDeletionRecord[], cloud: FavoriteDeletionRecord[]) {
  const merged = new Map<string, FavoriteDeletionRecord>();
  for (const record of [...local, ...cloud]) {
    const existing = merged.get(record.key);
    if (!existing || record.deletedAt > existing.deletedAt) merged.set(record.key, record);
  }
  return [...merged.values()].sort((a, b) => b.deletedAt - a.deletedAt);
}

function isSuppressedByDeletion(record: FavoriteRecord, deletions: FavoriteDeletionRecord[]) {
  const deletion = deletions.find((candidate) => candidate.key === record.key);
  return Boolean(deletion && record.updatedAt <= deletion.deletedAt);
}

export function mergeFavorites(local: FavoriteRecord[], cloud: FavoriteRecord[], deletions: FavoriteDeletionRecord[] = []) {
  const merged = new Map<string, FavoriteRecord>();
  for (const rawRecord of [...local, ...cloud]) {
    const record = { ...rawRecord, status: normalizeWatchlistStatus(rawRecord.status) };
    const existing = merged.get(record.key);
    if (!existing || record.updatedAt > existing.updatedAt || (record.updatedAt === existing.updatedAt && record.createdAt < existing.createdAt)) merged.set(record.key, record);
  }
  return [...merged.values()].filter((record) => !isSuppressedByDeletion(record, deletions)).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function mergeFavoritesWithProgress(favorites: FavoriteRecord[], progress: WatchProgressRecord[], deletions: FavoriteDeletionRecord[] = []) {
  const merged = new Map(mergeFavorites(favorites, [], deletions).map((record) => [record.key, { ...record, status: normalizeWatchlistStatus(record.status) }]));
  for (const record of progress) {
    if (record.completionState === 'completed' || record.currentTime <= 0) continue;
    const key = favoriteKey(record.contentType, record.contentId);
    if (deletions.some((deletion) => deletion.key === key)) continue;
    const existing = merged.get(key);
    const timestamp = Math.max(record.updatedAt, record.lastWatchedAt);
    const createdAt = existing?.createdAt ?? timestamp;
    const updatedAt = Math.max(existing?.updatedAt ?? 0, timestamp);
    if (existing) continue;
    merged.set(key, {
      key,
      contentType: record.contentType,
      contentId: record.contentId,
      snapshot: record.snapshot,
      status: 'watching',
      createdAt,
      updatedAt,
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
