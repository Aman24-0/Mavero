import type { WatchProgressRecord } from '../client/progress/types';

function activityTimestamp(record: WatchProgressRecord) {
  return Math.max(record.updatedAt, record.lastWatchedAt);
}

function isPositiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function safeRecord(record: WatchProgressRecord): WatchProgressRecord | undefined {
  if (
    record.completionState === 'completed' ||
    !Number.isFinite(record.currentTime) ||
    record.currentTime <= 0 ||
    !Number.isFinite(record.duration) ||
    record.duration < 0 ||
    !Number.isFinite(record.updatedAt) ||
    !Number.isFinite(record.lastWatchedAt) ||
    !record.snapshot ||
    typeof record.snapshot.title !== 'string'
  ) return undefined;

  const season = isPositiveInteger(record.season) ? record.season : undefined;
  const episode = isPositiveInteger(record.episode) ? record.episode : undefined;
  const snapshot = {
    title: record.snapshot.title || record.contentId,
    poster: typeof record.snapshot.poster === 'string' ? record.snapshot.poster : '',
    backdrop: typeof record.snapshot.backdrop === 'string' ? record.snapshot.backdrop : undefined,
    year: Number.isSafeInteger(record.snapshot.year) ? record.snapshot.year : undefined,
    runtime: typeof record.snapshot.runtime === 'string' ? record.snapshot.runtime : undefined,
    rating: typeof record.snapshot.rating === 'number' && Number.isFinite(record.snapshot.rating) ? record.snapshot.rating : undefined,
    genres: Array.isArray(record.snapshot.genres) ? record.snapshot.genres.filter((genre): genre is string => typeof genre === 'string') : [],
    description: typeof record.snapshot.description === 'string' ? record.snapshot.description : ''
  };

  const { season: _season, episode: _episode, ...base } = record;
  return {
    ...base,
    ...(season !== undefined && episode !== undefined ? { season, episode } : {}),
    snapshot
  };
}

/**
 * Select the TV Continue Watching read model without changing persisted progress.
 * One card represents one content title; the latest active episode wins for series/anime.
 */
export function selectTVContinueWatchingRecords(records: WatchProgressRecord[]) {
  const seenTitles = new Set<string>();
  const selected: WatchProgressRecord[] = [];

  for (const record of [...records].sort((left, right) => activityTimestamp(right) - activityTimestamp(left))) {
    const safe = safeRecord(record);
    if (!safe) continue;
    const titleKey = `${safe.contentType}:${safe.contentId}`;
    if (seenTitles.has(titleKey)) continue;
    seenTitles.add(titleKey);
    selected.push(safe);
  }

  return selected;
}
