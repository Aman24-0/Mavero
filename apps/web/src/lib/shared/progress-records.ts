// ============================================================================
// SHARED progress-record contract (types + keys + validators + normalizers).
//
// Phase 3 3-A (repository-cleanup roadmap, audit §3.3 #1+#2 / §7 P3-1):
// this module is the SINGLE SOURCE of the progress/favorite record
// contract. It was MOVED VERBATIM from `src/lib/client/progress/types.ts`
// (record-contract section) and `src/lib/client/progress/presenter.ts`
// (getLatestResumeTarget + its alias — pure record-selection logic, no
// DOM/browser dependency), because the SERVER (`supabase/records.ts`,
// `api/account/{favorites,favorites/batch-delete,sync}`) and the SHARED
// merge layer (`shared/progress-merge.ts`) both need these definitions —
// importing them from client-land created runtime server→client and
// shared→client layering inversions.
//
// Direction contract after this move:
//   server  → shared/progress-records  (correct: downward)
//   shared  → shared/progress-records  (correct: sideways)
//   client  → shared/progress-records  (correct: downward; the client
//             modules keep their import surface via the re-export façade
//             in `client/progress/types.ts` + `client/progress/presenter.ts`)
// ============================================================================

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
  // Deep-audit Section 4: the anime classification travels WITH the
  // snapshot so Continue Watching / My List can rebuild the canonical
  // /anime-movie/ + /watch/anime-movie/ + /anime-series/ identities from
  // persisted records WITHOUT re-fetching TMDB. Previously the snapshot
  // dropped isAnime entirely and the presenters rebuilt legacy
  // /watch/movie/movie-{id} URLs — the duplication source.
  //
  // Backward compatibility: records written before this field have no
  // flag. Readers fall back to the record's own contentType — an 'anime'
  // contentType means an anime series; a 'movie'/'series' record without
  // the flag renders with its historical (non-anime) identity rather than
  // guessing from genre names.
  isAnime?: boolean;
  animeFormat?: 'movie' | 'series';
};

export type PlaybackContext = {
  contentType: LocalContentType;
  contentId: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
};

export type SourceRuntimeEntry = {
  duration: number;
  updatedAt: number;
};

export type WatchProgressRecord = PlaybackContext & {
  key: string;
  currentTime: number;
  duration: number;
  completionState: CompletionState;
  selectedSourceId?: string;
  sourceRuntimes?: Record<string, SourceRuntimeEntry>;
  snapshot: ContentSnapshot;
  lastWatchedAt: number;
  updatedAt: number;
  // Cross-device conflict resolution: the timestamp of the LAST update
  // that actually advanced the playback position (currentTime). This is
  // distinct from `updatedAt` (which advances on ANY record mutation,
  // including runtime-only updates that do NOT change the position).
  //
  // Why this field exists:
  //   A runtime-only update (e.g. a provider emitting a duration event
  //   without a progress event) calls saveProgress() which stamps
  //   updatedAt = Date.now(). Without positionUpdatedAt, mergeProgress()
  //   would see the stale-position record as "fresher" (newer updatedAt)
  //   and let it overwrite a real-position record from another device
  //   that had an older updatedAt but a genuinely newer currentTime.
  //   This is the exact regression that caused Midsommar's position to
  //   drop from ~1h29m to ~28m.
  //
  // positionUpdatedAt is ONLY advanced when currentTime actually
  // changes. mergeProgress() uses positionUpdatedAt (not updatedAt) as
  // the position-freshness signal. Runtime metadata (duration,
  // sourceRuntimes) still merges by its own per-entry updatedAt.
  //
  // Backward compatibility: old records (local IDB + cloud rows created
  // before this field) have positionUpdatedAt = 0. The merge logic
  // falls back to `updatedAt` when positionUpdatedAt is 0, preserving
  // the old behavior for pre-migration records.
  positionUpdatedAt: number;
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

export type CloudProgressRecord = WatchProgressRecord;

export function progressKey(context: PlaybackContext) {
  return [context.contentType, context.contentId, context.season ?? '-', context.episode ?? '-'].join(':');
}

export function favoriteKey(contentType: LocalContentType, contentId: string) {
  return `${contentType}:${contentId}`;
}

export function completionFor(currentTime: number, duration: number, explicit = false): CompletionState {
  // BUG #8 fix: completion is ONLY from an explicit 'ended' event.
  // The previous 0.9 (90%) threshold was too aggressive — a movie
  // watched to 90% but paused in the credits would be marked 'completed',
  // zeroing the resume position (via getResumeProgress). OTT apps
  // (Netflix, Disney+, Apple TV+) use explicit 'ended' or 97-98%.
  // We use explicit-only: no implicit percentage-based completion.
  // The position remains resumable until the user actually finishes.
  if (explicit) return 'completed';
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
  // Task 2: validate the anime discriminator fields when present so a
  // corrupt payload cannot leak into the classification (the flags are
  // optional for backward compatibility with pre-discriminator records).
  const validAnimeFlags = (snapshot.isAnime === undefined || typeof snapshot.isAnime === 'boolean')
    && (snapshot.animeFormat === undefined || snapshot.animeFormat === 'movie' || snapshot.animeFormat === 'series');
  return validAnimeFlags
    && isBoundedString(snapshot.title, MAX_SNAPSHOT_TITLE_LENGTH)
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
  // Phase 9: validate sourceRuntimes if present (optional field, backward compatible).
  const validSourceRuntimes = record.sourceRuntimes === undefined
    || (typeof record.sourceRuntimes === 'object' && record.sourceRuntimes !== null && !Array.isArray(record.sourceRuntimes)
      && Object.entries(record.sourceRuntimes).every(([key, entry]) =>
        typeof key === 'string' && key.length > 0 && key.length <= 100
        && typeof entry === 'object' && entry !== null
        && typeof (entry as SourceRuntimeEntry).duration === 'number' && Number.isFinite((entry as SourceRuntimeEntry).duration) && (entry as SourceRuntimeEntry).duration > 0
        && typeof (entry as SourceRuntimeEntry).updatedAt === 'number' && Number.isFinite((entry as SourceRuntimeEntry).updatedAt)
      ));
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
    && isContentSnapshot(record.snapshot)
    && validSourceRuntimes
    // positionUpdatedAt is optional for backward compatibility — old
    // records (pre-migration) won't have it. When present, it must be a
    // finite positive timestamp. When absent, merge logic falls back to
    // updatedAt.
    && (record.positionUpdatedAt === undefined || (typeof record.positionUpdatedAt === 'number' && Number.isFinite(record.positionUpdatedAt) && record.positionUpdatedAt >= 0));
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

/**
 * P2: ONE canonical helper for finding the LATEST RESUME TARGET.
 *
 * A "resume target" is the episode/position the user should resume from.
 * This is DIFFERENT from "has actual playback progress" — a user can
 * click S2E3 and immediately leave before any provider emits a
 * timeupdate. S2E3 is STILL the resume target even with currentTime=0.
 *
 * Rules:
 *   - exact contentType + contentId match
 *   - completionState !== 'completed'
 *   - For MOVIES: currentTime > 0 (movies have no episode; a zero-progress
 *     movie record is not a meaningful resume target — use "Play" instead)
 *   - For SERIES/ANIME: valid season + episode (positive integers).
 *     currentTime MAY be 0 — the user selected this episode, that's enough.
 *
 * Ordering:
 *   1. latest max(updatedAt, lastWatchedAt) wins
 *   2. tie-break: higher currentTime wins (user watched further)
 *   3. never depends on array ordering
 *
 * Phase 3 3-A: moved verbatim from `client/progress/presenter.ts` — this
 * is pure record-selection logic (no DOM/browser dependency) and the
 * SHARED `progress-merge.ts` consumes it, which had created a
 * shared→client runtime inversion.
 */
export function getLatestResumeTarget(
  contentType: WatchProgressRecord['contentType'],
  contentId: string,
  records: WatchProgressRecord[],
): WatchProgressRecord | undefined {
  const isSeriesLike = contentType === 'series' || contentType === 'anime';
  return records
    .filter((r) =>
      r.contentType === contentType &&
      r.contentId === contentId &&
      r.completionState !== 'completed' &&
      (!isSeriesLike
        ? r.currentTime > 0  // movies: require actual playback
        : r.season !== undefined && r.episode !== undefined && r.season > 0 && r.episode > 0  // series: just need valid episode
      )
    )
    .sort((a, b) => {
      const aTime = Math.max(a.updatedAt, a.lastWatchedAt);
      const bTime = Math.max(b.updatedAt, b.lastWatchedAt);
      if (bTime !== aTime) return bTime - aTime;
      return b.currentTime - a.currentTime;
    })[0];
}

/**
 * Backward-compatible alias. getLatestActiveProgress now delegates to
 * getLatestResumeTarget. The old name is kept for any external callers.
 */
export function getLatestActiveProgress(
  contentType: WatchProgressRecord['contentType'],
  contentId: string,
  records: WatchProgressRecord[],
): WatchProgressRecord | undefined {
  return getLatestResumeTarget(contentType, contentId, records);
}
