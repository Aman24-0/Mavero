import { favoriteKey, normalizeWatchlistStatus, type FavoriteDeletionRecord, type FavoriteRecord, type WatchProgressRecord, type CloudProgressRecord, type SourceRuntimeEntry } from '$lib/client/progress/types';
import { getLatestResumeTarget } from '$lib/client/progress/presenter';

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
    if (record.completionState === 'completed') continue;
    // P16 fix: do NOT skip zero-progress series records — a user can
    // manually select an episode (creating a progress record with
    // currentTime=0) and that should still promote the favorite to
    // "watching" status. For movies, currentTime=0 means nothing
    // was actually watched — skip those.
    const isSeriesLike = record.contentType === 'series' || record.contentType === 'anime';
    if (!isSeriesLike && record.currentTime <= 0) continue;
    // For series: require valid season+episode OR currentTime > 0
    if (isSeriesLike && record.currentTime <= 0 && (record.season === undefined || record.episode === undefined)) continue;
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
  // P6+P7: ONE Continue Watching entry per title.
  // For series/anime: use getLatestResumeTarget() to find the latest
  // episode (even with currentTime=0). For movies: require currentTime > 0.
  // The old code filtered currentTime > 0 and created synthetic
  // manualWatching records WITHOUT season/episode — losing episode context.
  const byTitle = new Map<string, WatchProgressRecord>();
  // Group all progress records by content title and pick the latest resume target.
  const titlesInProgress = new Set<string>();
  for (const record of progress) {
    if (record.completionState === 'completed') continue;
    const titleKey = favoriteKey(record.contentType, record.contentId);
    titlesInProgress.add(titleKey);
    const existing = byTitle.get(titleKey);
    if (!existing) {
      byTitle.set(titleKey, record);
    } else {
      // Pick the newer one (or the one with higher currentTime on tie).
      const existingTime = Math.max(existing.updatedAt, existing.lastWatchedAt);
      const recordTime = Math.max(record.updatedAt, record.lastWatchedAt);
      if (recordTime > existingTime || (recordTime === existingTime && record.currentTime > existing.currentTime)) {
        byTitle.set(titleKey, record);
      }
    }
  }
  // For each title, use getLatestResumeTarget to ensure the correct episode.
  const result: WatchProgressRecord[] = [];
  for (const [titleKey, _] of byTitle) {
    // Parse contentType + contentId from the title key.
    const [contentType, contentId] = titleKey.split(':');
    if (!contentType || !contentId) continue;
    const target = getLatestResumeTarget(contentType as WatchProgressRecord['contentType'], contentId, progress);
    if (target) {
      result.push(target);
    } else {
      // Fallback: use the record from byTitle (could be a movie with currentTime>0
      // or a series record that didn't match getLatestResumeTarget's filter).
      const fallback = byTitle.get(titleKey);
      if (fallback && fallback.currentTime > 0) result.push(fallback);
    }
  }
  // Also include manual "watching" favorites that have NO progress records at all
  // (series the user added to My List as "watching" but never started).
  const progressKeys = new Set(result.map((r) => favoriteKey(r.contentType, r.contentId)));
  for (const fav of favorites) {
    if (normalizeWatchlistStatus(fav.status) !== 'watching') continue;
    const key = favoriteKey(fav.contentType, fav.contentId);
    if (progressKeys.has(key)) continue;
    // Synthetic record for "watching" with no progress — S1E1 for series.
    result.push({
      key: `${key}:watching`,
      contentType: fav.contentType,
      contentId: fav.contentId,
      season: fav.contentType !== 'movie' ? 1 : undefined,
      episode: fav.contentType !== 'movie' ? 1 : undefined,
      currentTime: 0,
      duration: 0,
      completionState: 'in_progress' as const,
      snapshot: fav.snapshot,
      lastWatchedAt: fav.updatedAt,
      updatedAt: fav.updatedAt,
    });
    progressKeys.add(key);
  }
  return result.sort((a, b) => Math.max(b.updatedAt, b.lastWatchedAt) - Math.max(a.updatedAt, a.lastWatchedAt));
}
