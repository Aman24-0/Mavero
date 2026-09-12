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
  // Phase 9 fix (race-safe): invalidate any active writer for this title BEFORE
  // deleting progress, AND drain any in-flight flush before deleting. This
  // guarantees that a pending/queued/in-flight flush cannot recreate the
  // deleted record.
  //
  // Step 1: invalidateWritersForContent() bumps the per-title generation
  //   token and disposes every active writer for this title. From this point
  //   on, any writer callback (queued setTimeout, pause, complete, update,
  //   updateRuntime, flush) will see disposed=true and return immediately
  //   without persisting.
  invalidateWritersForContent(contentType, contentId);
  // Step 2: drain in-flight persistence. Any flush() that already passed the
  //   disposed check and is currently awaiting saveProgress() will finish
  //   its post-check (which sees the bumped generation and undoes its write
  //   via removeProgress). We MUST wait for these to settle before deleting
  //   progress, otherwise the in-flight put transaction would commit AFTER
  //   deleteAllProgressForContent and recreate the deleted record.
  await drainPendingWritesForContent(contentType, contentId);
  // Step 3: delete ALL watch progress for this title (every season:episode)
  //   so it disappears from Continue Watching immediately.
  await deleteAllProgressForContent(contentType, contentId);
  await removeFavorite(contentType, contentId);
  await putFavoriteDeletion({ key, contentType, contentId, deletedAt });
}

/**
 * Phase 9 fix: Delete ALL watch progress records for a given content title.
 * For movies, this deletes the single movie progress record.
 * For series/anime, this deletes ALL episode progress records belonging to
 * the specified contentId (every season:episode combination).
 */
export async function deleteAllProgressForContent(contentType: LocalContentType, contentId: string) {
  const allProgress = await listProgress();
  const toDelete = allProgress.filter((record) => record.contentType === contentType && record.contentId === contentId);
  await Promise.all(toDelete.map((record) => removeProgress(record)));
}

// ============================================================
// Phase 9 fix (race-safe): Title-level writer invalidation registry.
//
// PREVIOUS BUG: activeWriters stored only `{ dispose }` and
// unregisterWriter() blindly called `activeWriters.delete(key)`. When
// writer A was replaced by writer B for the same title, A's late
// dispose() (e.g. from component unmount) would delete the registry
// entry that now belonged to B. After that, removeFavoriteFromMyList()
// could not find B to invalidate it, so B's pending flush recreated
// the deleted progress.
//
// FIX: each registry entry carries a unique identity `id` (Symbol) and
// the per-title `generation` token at the time it was registered.
//
//   - unregisterWriter(key, writerId) only deletes the entry if its id
//     still equals writerId. An old writer can NEVER unregister a newer
//     writer.
//
//   - invalidateWritersForContent() bumps the per-title generation
//     BEFORE disposing. Every flush captures its generation token
//     before awaiting saveProgress(); after the await it re-checks the
//     title generation. If the title was invalidated during the await
//     (delete-wins semantics), the flush undoes its just-completed
//     putProgress via removeProgress.
//
//   - drainPendingWritesForContent() awaits all in-flight flushes for
//     the title so removeFavoriteFromMyList() can deterministically
//     delete progress AFTER every stale write has settled.
// ============================================================

type ActiveWriterEntry = {
  id: symbol;
  dispose: () => void;
};

const activeWriters = new Map<string, ActiveWriterEntry>();
const titleGenerations = new Map<string, number>();
const activeTitleFlushes = new Map<string, Set<Promise<unknown>>>();

function writerRegistryKey(contentType: string, contentId: string): string {
  return `${contentType}:${contentId}`;
}

function getTitleGeneration(key: string): number {
  return titleGenerations.get(key) ?? 0;
}

function bumpTitleGeneration(key: string): number {
  const next = (titleGenerations.get(key) ?? 0) + 1;
  titleGenerations.set(key, next);
  return next;
}

function registerWriter(contentType: string, contentId: string, dispose: () => void): { id: symbol; generation: number } {
  const key = writerRegistryKey(contentType, contentId);
  // If a previous writer for the same title exists, dispose it first.
  // This only runs the OLD writer's dispose closure (sets disposed=true,
  // clears its timer + latest). It does NOT touch the registry entry
  // beyond overwriting it below.
  const existing = activeWriters.get(key);
  if (existing) { try { existing.dispose(); } catch { /* already disposed */ } }
  const id = Symbol('progress-writer');
  // Capture the current title generation. The writer's flush() will use
  // this token to detect that the title was invalidated while it was
  // awaiting saveProgress().
  const generation = getTitleGeneration(key);
  activeWriters.set(key, { id, dispose });
  return { id, generation };
}

/**
 * Identity-safe unregister: only deletes the registry entry if its id
 * still matches `writerId`. If a newer writer has replaced this one
 * (same title, different id), this call is a no-op so the newer writer
 * remains reachable by invalidateWritersForContent().
 */
function unregisterWriter(contentType: string, contentId: string, writerId: symbol) {
  const key = writerRegistryKey(contentType, contentId);
  const entry = activeWriters.get(key);
  if (entry && entry.id === writerId) {
    activeWriters.delete(key);
  }
  // else: a newer writer replaced this one. Leave the registry entry
  // intact so removeFavoriteFromMyList() can still find and invalidate
  // the active writer.
}

/**
 * Phase 9 fix (race-safe): Invalidate and dispose ALL active writers for a
 * specific title. Called by removeFavoriteFromMyList() BEFORE deleting
 * progress records.
 *
 * This does TWO things, in this order:
 *   1. Bumps the per-title generation token. Any in-flight flush() that
 *      has already passed its `disposed` check and is awaiting
 *      saveProgress() will, on resolution, see that its captured
 *      generation no longer matches the title's current generation and
 *      will undo its write via removeProgress().
 *   2. Disposes every active writer for the title (sets disposed=true,
 *      clears the setTimeout timer, clears `latest`). Any subsequent
 *      callback (queued setTimeout, pause, complete, update,
 *      updateRuntime, flush) is a no-op from this point on.
 */
export function invalidateWritersForContent(contentType: string, contentId: string) {
  const key = writerRegistryKey(contentType, contentId);
  bumpTitleGeneration(key);
  const entry = activeWriters.get(key);
  if (entry) {
    try { entry.dispose(); } catch { /* already disposed */ }
    activeWriters.delete(key);
  }
}

function trackFlush(contentType: string, contentId: string, promise: Promise<unknown>) {
  const key = writerRegistryKey(contentType, contentId);
  let set = activeTitleFlushes.get(key);
  if (!set) {
    set = new Set();
    activeTitleFlushes.set(key, set);
  }
  set.add(promise);
  // Auto-remove on settle so the set never grows unbounded.
  promise.then(
    () => {
      const current = activeTitleFlushes.get(key);
      if (current) { current.delete(promise); if (current.size === 0) activeTitleFlushes.delete(key); }
    },
    () => {
      const current = activeTitleFlushes.get(key);
      if (current) { current.delete(promise); if (current.size === 0) activeTitleFlushes.delete(key); }
    }
  );
}

/**
 * Await every in-flight flush() promise tracked for this title.
 * Used by removeFavoriteFromMyList() to guarantee that no stale
 * putProgress transaction can commit AFTER deleteAllProgressForContent()
 * and recreate the deleted record. Safe to call when there are no
 * pending flushes (returns immediately).
 */
async function drainPendingWritesForContent(contentType: string, contentId: string) {
  const key = writerRegistryKey(contentType, contentId);
  const set = activeTitleFlushes.get(key);
  if (!set || set.size === 0) return;
  // allSettled: a rejected flush must not abort the drain — we still
  // need deleteAllProgressForContent to run afterward.
  await Promise.allSettled([...set]);
}

export async function deleteFavorite(contentType: LocalContentType, contentId: string) {
  return removeFavoriteFromMyList(contentType, contentId);
}

// ============================================================
// My List management: batch helpers.
//
// These are thin orchestrators over the existing single-title
// primitives (`removeFavoriteFromMyList`, `saveFavorite`) so that all
// race-safety / tombstone / progress-deletion guarantees are reused
// unchanged — no second persistence architecture.
//
// `batchRemoveFromMyList` runs each removal sequentially. The
// underlying `removeFavoriteFromMyList` already awaits in-flight
// writer flushes and bumps the per-title generation token, so running
// them sequentially (rather than in parallel) avoids unnecessary
// contention on the IndexedDB transaction queue and makes partial-
// failure recovery simpler.
// ============================================================

export type FavoriteIdentity = { contentType: LocalContentType; contentId: string };

/**
 * Remove multiple favorites locally + persist tombstones for each.
 *
 * Reuses `removeFavoriteFromMyList` for each identity, which means:
 *   - active progress writers for each title are invalidated BEFORE
 *     the favorite is removed (delete-wins semantics),
 *   - in-flight flushes are drained so no stale putProgress can
 *     recreate a deleted record,
 *   - ALL watch_progress records for each title are deleted,
 *   - a favorite_deletions tombstone is written for each identity.
 *
 * Returns per-identity success/failure so the caller can report
 * partial results honestly without silently dropping failures.
 */
export async function batchRemoveFromMyList(items: FavoriteIdentity[]): Promise<{ succeeded: FavoriteIdentity[]; failed: { item: FavoriteIdentity; error: string }[] }> {
  const succeeded: FavoriteIdentity[] = [];
  const failed: { item: FavoriteIdentity; error: string }[] = [];
  for (const item of items) {
    try {
      await removeFavoriteFromMyList(item.contentType, item.contentId);
      succeeded.push(item);
    } catch (error) {
      failed.push({ item, error: error instanceof Error ? error.message : 'unknown' });
    }
  }
  return { succeeded, failed };
}

/**
 * Update the status of multiple favorites locally.
 *
 * Reuses `saveFavorite` for each identity so that:
 *   - createdAt is preserved (saveFavorite reads the existing record),
 *   - updatedAt is bumped to the current timestamp,
 *   - snapshot/content identity is preserved,
 *   - any prior favorite_deletions tombstone is cleared (the user is
 *     explicitly re-adding the title to a status).
 *
 * Returns per-identity success/failure. The caller should perform a
 * SINGLE cloud sync after the batch completes (not one sync per
 * item).
 */
export async function batchSetFavoriteStatus(items: FavoriteIdentity[], status: WatchlistStatus, now = Date.now()): Promise<{ succeeded: FavoriteIdentity[]; failed: { item: FavoriteIdentity; error: string }[] }> {
  const succeeded: FavoriteIdentity[] = [];
  const failed: { item: FavoriteIdentity; error: string }[] = [];
  // Pre-fetch the existing records so we can preserve their snapshot
  // exactly. listFavorites is one IndexedDB read; doing it once here
  // is cheaper than N getFavorite calls.
  const existing = await listFavorites();
  const byKey = new Map(existing.map((record) => [record.key, record]));
  for (const item of items) {
    try {
      const key = favoriteKey(item.contentType, item.contentId);
      const prior = byKey.get(key);
      // If the title isn't in My List anymore (race with another tab),
      // there is nothing to update — record as failed so the caller
      // can refresh and reconcile.
      if (!prior) {
        failed.push({ item, error: 'not-found' });
        continue;
      }
      // Preserve createdAt + snapshot from the prior record; bump updatedAt.
      await putFavorite({
        key,
        contentType: item.contentType,
        contentId: item.contentId,
        snapshot: prior.snapshot,
        status: normalizeWatchlistStatus(status),
        createdAt: prior.createdAt,
        updatedAt: now
      });
      succeeded.push(item);
    } catch (error) {
      failed.push({ item, error: error instanceof Error ? error.message : 'unknown' });
    }
  }
  return { succeeded, failed };
}

/** @deprecated Use removeFavoriteFromMyList. Kept as a safe compatibility alias; playback is never deleted. */
export async function deleteFavoriteAndProgress(contentType: LocalContentType, contentId: string) {
  return removeFavoriteFromMyList(contentType, contentId);
}

export async function getLocalPersistenceState() {
  return getLocalProgressState();
}

export function createProgressWriter(base: Omit<SaveProgressInput, 'currentTime' | 'duration'> & { initialCurrentTime?: number; initialDuration?: number }, flushInterval = DEFAULT_FLUSH_INTERVAL) {
  let latest: SaveProgressInput | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  // Phase 9: per-source runtime map. Accumulated across source switches.
  let sourceRuntimes: Record<string, { duration: number; updatedAt: number }> = base.sourceRuntimes ? { ...base.sourceRuntimes } : {};
  // Phase 9 fix: initialize knownCurrentTime from existing progress so
  // updateRuntime() never resets it to 0 over an existing resume position.
  let knownCurrentTime = Math.max(0, Number.isFinite(base.initialCurrentTime) ? (base.initialCurrentTime ?? 0) : 0);
  // Phase 20 fix: track the last known valid duration so that a later update()
  // call with duration=0/undefined cannot overwrite a previously received
  // valid duration. This is the root cause of the Viduki progress bug:
  // MEDIA_DATA arrives with a valid duration, but a subsequent update() call
  // (e.g., from a seeked event or a non-MEDIA_DATA timeupdate) passes
  // duration=0/undefined, which overwrites latest.duration, causing the
  // persisted record to have duration=0 → "Resume" with no progress bar.
  let lastKnownDuration = Math.max(0, Number.isFinite(base.initialDuration) ? (base.initialDuration ?? 0) : 0);

  // Phase 9 fix (race-safe): register this writer in the title-level
  // registry so removeFavoriteFromMyList() can invalidate it. The
  // registry gives us back:
  //   - writerId: unique Symbol identity token. Used by our public
  //     dispose() to identity-check before unregistering, so we can
  //     NEVER kick out a newer writer that replaced us.
  //   - writerGeneration: snapshot of the per-title generation token at
  //     registration time. Our flush() captures this BEFORE awaiting
  //     saveProgress(); if the title was invalidated during the await
  //     (generation bumped), the post-check undoes the just-completed
  //     putProgress via removeProgress. This closes the async in-flight
  //     race that the disposed-only check could not cover.
  const writerKey = writerRegistryKey(base.contentType, base.contentId);
  const { id: writerId, generation: writerGeneration } = registerWriter(base.contentType, base.contentId, () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    latest = undefined;
  });

  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    // Phase 9 fix: disposed check prevents stale flushes (queued
    // setTimeout callback that fired before clearTimeout, or a writer
    // replaced by a newer writer) from persisting.
    if (disposed || !latest) return;
    const next = { ...latest, sourceRuntimes: { ...sourceRuntimes } };
    latest = undefined;
    // Phase 9 fix (race-safe): capture the title generation token
    // BEFORE awaiting saveProgress(). If removeFavoriteFromMyList()
    // invalidates the title during the await, the title's current
    // generation will no longer match this captured value, and the
    // post-check below will undo our write via removeProgress().
    const capturedGeneration = writerGeneration;
    // Track the in-flight promise so removeFavoriteFromMyList() can
    // deterministically drain it before deleting progress.
    const promise = (async () => {
      try {
        await saveProgress(next);
      } catch {
        // saveProgress itself failed; nothing to undo. Swallow so the
        // tracked promise resolves and the drain step in
        // removeFavoriteFromMyList is not blocked by a stale error.
        return;
      }
      // Post-check (delete-wins): if the title was invalidated while
      // we were awaiting saveProgress(), undo the write so we never
      // recreate a deleted progress record. This is the only line of
      // defense against the async in-flight race because the disposed
      // check at the top of flush() ran BEFORE the invalidation.
      if (capturedGeneration !== getTitleGeneration(writerKey)) {
        try {
          await removeProgress({ contentType: next.contentType, contentId: next.contentId, season: next.season, episode: next.episode });
        } catch { /* cleanup is best-effort; deleteAllProgressForContent will retry */ }
      }
    })();
    trackFlush(base.contentType, base.contentId, promise);
    return promise;
  };

  const schedule = () => {
    if (timer || disposed) return;
    timer = setTimeout(() => { void flush(); }, flushInterval);
  };

  // Return the writer object with dispose that also unregisters from the registry.
  const writer = {
    update(currentTime: number, duration?: number, completed = false) {
      if (disposed) return; // Phase 9 fix: no-op if invalidated.
      knownCurrentTime = currentTime;
      // Phase 20 fix: preserve the last known valid duration. A later update()
      // call with duration=0/undefined must NOT overwrite a previously received
      // valid duration. This is the root cause of the Viduki progress bug.
      const effectiveDuration = duration && duration > 0 ? duration : lastKnownDuration;
      if (duration && duration > 0) lastKnownDuration = duration;
      if (effectiveDuration > 0 && base.selectedSourceId) {
        sourceRuntimes[base.selectedSourceId] = { duration: effectiveDuration, updatedAt: Date.now() };
      }
      latest = { ...base, currentTime, duration: effectiveDuration, completed, sourceRuntimes: { ...sourceRuntimes } };
      schedule();
    },
    updateRuntime(sourceId: string, duration: number) {
      if (disposed || !Number.isFinite(duration) || duration <= 0) return;
      sourceRuntimes[sourceId] = { duration, updatedAt: Date.now() };
      if (duration > 0) lastKnownDuration = duration; // Phase 20 fix: track duration.
      if (latest) {
        latest.sourceRuntimes = { ...sourceRuntimes };
      } else {
        // Phase 20 fix: use lastKnownDuration so the persisted record has a
        // valid duration instead of undefined/0.
        latest = { ...base, currentTime: knownCurrentTime, duration: lastKnownDuration, sourceRuntimes: { ...sourceRuntimes } };
        schedule();
      }
    },
    pause() {
      return flush();
    },
    complete(currentTime: number, duration?: number) {
      if (disposed) return Promise.resolve(); // Phase 9 fix: no-op if invalidated.
      knownCurrentTime = currentTime;
      // Phase 20 fix: use effectiveDuration to preserve the last known duration.
      const effectiveDuration = duration && duration > 0 ? duration : lastKnownDuration;
      latest = { ...base, currentTime, duration: effectiveDuration, completed: true, sourceRuntimes: { ...sourceRuntimes } };
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
      // Phase 9 fix (race-safe): identity-safe unregister. Only delete
      // the registry entry if it still belongs to THIS writer (same id).
      // If a newer writer has replaced us, the registry entry now belongs
      // to that newer writer, and we MUST NOT evict it — otherwise
      // removeFavoriteFromMyList() would be unable to invalidate the
      // active writer and its pending flush would recreate the deleted
      // progress.
      unregisterWriter(base.contentType, base.contentId, writerId);
    }
  };
  return writer;
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

// Phase 9 fix: format remaining time correctly.
// < 60 min: "Xm left"
// >= 60 min: "Xh Ym left" or "Xh left" if minutes is 0.
function formatRemainingTime(totalMinutes: number): string {
  if (totalMinutes <= 0) return 'Resume';
  if (totalMinutes < 60) return `${totalMinutes}m left`;
  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  if (remainingMinutes === 0) return `${hours}h left`;
  return `${hours}h ${remainingMinutes}m left`;
}

export function progressLabel(record: WatchProgressRecord) {
  const effectiveDuration = getRuntimeForSource(record, record.selectedSourceId);
  const remaining = effectiveDuration > 0 ? Math.max(0, Math.round((effectiveDuration - record.currentTime) / 60)) : 0;
  const time = formatRemainingTime(remaining);
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
