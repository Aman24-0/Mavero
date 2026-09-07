import { listFavoriteDeletions, listFavorites, listProgress, putFavorite, putFavoriteDeletion, putProgress, removeFavorite, removeFavoriteDeletion } from './database';
import { mergeFavoriteDeletions, mergeFavorites, mergeFavoritesWithProgress, mergeProgress } from '$lib/shared/progress-merge';
import type { FavoriteDeletionRecord, FavoriteRecord, WatchProgressRecord } from './types';
import type { FutureCloudProgressAdapter } from './service';

export type SyncStatus = 'synced' | 'syncing' | 'pending' | 'offline' | 'error';

type CloudSyncResponse = {
  progress: WatchProgressRecord[];
  favorites: FavoriteRecord[];
  favoriteDeletions: FavoriteDeletionRecord[];
};

let syncStatus: SyncStatus = 'pending';
let syncInFlight: Promise<SyncResult> | undefined;

type SyncResult = {
  authenticated: boolean;
  progress: WatchProgressRecord[];
  favorites: FavoriteRecord[];
  favoriteDeletions: FavoriteDeletionRecord[];
  status: SyncStatus;
  error?: unknown;
};

function setSyncStatus(next: SyncStatus) {
  syncStatus = next;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('mavero:sync-status', { detail: next }));
}

export function getSyncStatus() {
  return syncStatus;
}

async function readCloud(fetcher: typeof fetch): Promise<CloudSyncResponse | null> {
  const response = await fetcher('/api/account/sync');
  if (response.status === 401) return null;
  if (!response.ok) throw new Error('cloud-read-failed');
  return await response.json() as CloudSyncResponse;
}

async function writeCloud(fetcher: typeof fetch, progress: WatchProgressRecord[], favorites: FavoriteRecord[], favoriteDeletions: FavoriteDeletionRecord[]) {
  const response = await fetcher('/api/account/sync', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ progress, favorites, favoriteDeletions }),
  });
  if (response.status === 401) return false;
  if (!response.ok) throw new Error('cloud-write-failed');
  return true;
}

export function syncAuthenticatedState(fetcher: typeof fetch = fetch): Promise<SyncResult> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = runAuthenticatedState(fetcher);
  void syncInFlight.finally(() => { syncInFlight = undefined; });
  return syncInFlight;
}

async function runAuthenticatedState(fetcher: typeof fetch = fetch): Promise<SyncResult> {
  setSyncStatus('syncing');
  try {
    const [localProgress, localFavorites, localFavoriteDeletions, cloud] = await Promise.all([listProgress(), listFavorites(), listFavoriteDeletions(), readCloud(fetcher)]);
    if (!cloud) {
      setSyncStatus('pending');
      return { authenticated: false, progress: localProgress, favorites: mergeFavorites(localFavorites, [], localFavoriteDeletions), favoriteDeletions: localFavoriteDeletions, status: syncStatus };
    }

    const favoriteDeletions = mergeFavoriteDeletions(localFavoriteDeletions, cloud.favoriteDeletions ?? []);
    const progress = mergeProgress(localProgress, cloud.progress);
    const favorites = mergeFavoritesWithProgress(mergeFavorites(localFavorites, cloud.favorites, favoriteDeletions), progress, favoriteDeletions);
    const effectiveDeletions = favoriteDeletions.filter((deletion) => {
      const favorite = favorites.find((record) => record.key === deletion.key);
      return !favorite || favorite.updatedAt <= deletion.deletedAt;
    });
    const written = await writeCloud(fetcher, progress, favorites, effectiveDeletions);
    if (!written) {
      setSyncStatus('pending');
      return { authenticated: false, progress: localProgress, favorites: localFavorites, favoriteDeletions: localFavoriteDeletions, status: syncStatus };
    }

    const mergedFavoriteKeys = new Set(favorites.map((record) => record.key));
    await Promise.all([
      ...progress.map(putProgress),
      ...favorites.map(putFavorite),
      ...effectiveDeletions.map(putFavoriteDeletion),
      ...localFavoriteDeletions.filter((deletion) => !effectiveDeletions.some((record) => record.key === deletion.key)).map((deletion) => removeFavoriteDeletion(deletion.contentType, deletion.contentId)),
      ...localFavorites.filter((record) => !mergedFavoriteKeys.has(record.key)).map((record) => removeFavorite(record.contentType, record.contentId)),
    ]);
    setSyncStatus('synced');
    return { authenticated: true, progress, favorites, favoriteDeletions: effectiveDeletions, status: syncStatus };
  } catch (error) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    setSyncStatus(offline ? 'offline' : 'error');
    const [fallbackProgress, fallbackFavorites, fallbackDeletions] = await Promise.all([listProgress(), listFavorites(), listFavoriteDeletions()]);
    return { authenticated: true, progress: fallbackProgress, favorites: mergeFavorites(fallbackFavorites, [], fallbackDeletions), favoriteDeletions: fallbackDeletions, status: syncStatus, error };
  }
}

export const supabaseCloudProgressAdapter: FutureCloudProgressAdapter = {
  async list() {
    const cloud = await readCloud(fetch);
    return cloud?.progress ?? [];
  },
  async upsert(records) {
    await writeCloud(fetch, records, [], []);
  },
};

export async function deleteCloudFavorite(contentType: string, contentId: string, fetcher: typeof fetch = fetch) {
  try {
    if (syncInFlight) {
      try { await syncInFlight; } catch { /* deletion still gets its own request */ }
    }
    // Phase 9 fix: also delete cloud watch_progress for this title (all episodes).
    await deleteCloudProgress(contentType, contentId, fetcher);
    const response = await fetcher(`/api/account/favorites?contentType=${encodeURIComponent(contentType)}&contentId=${encodeURIComponent(contentId)}`, { method: 'DELETE' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Phase 9 fix: Delete all cloud watch_progress records for a given title.
 * The cloud API at /api/account/progress accepts DELETE with contentType + contentId
 * and deletes ALL episode progress records for that title.
 */
export async function deleteCloudProgress(contentType: string, contentId: string, fetcher: typeof fetch = fetch) {
  try {
    const response = await fetcher(`/api/account/progress?contentType=${encodeURIComponent(contentType)}&contentId=${encodeURIComponent(contentId)}`, { method: 'DELETE' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Batch cloud removal for the My List page.
 *
 * Calls the dedicated `/api/account/favorites/batch-delete` endpoint,
 * which delegates to a single atomic Postgres RPC
 * (`public.batch_remove_favorites(jsonb)`) that:
 *   - upserts a `favorite_deletions` tombstone per identity,
 *   - deletes the matching `favorites` rows,
 *   - deletes ALL `watch_progress` rows for those titles,
 *   - does NOT touch `watch_history` (separate audit log).
 *
 * The endpoint runs entirely inside the database, scoped to the
 * authenticated user's own rows (SECURITY INVOKER + RLS), and returns
 * per-identity success/failure so the caller can report partial results
 * honestly.
 *
 * Returns `{ ok, succeeded, failed }`. `ok=false` means the entire
 * request failed (network, auth, 503, malformed payload). Otherwise
 * callers should consult `succeeded` / `failed`.
 */
export type BatchCloudFavoriteItem = { contentType: string; contentId: string };
export type BatchCloudDeleteResult = {
  ok: boolean;
  succeeded: BatchCloudFavoriteItem[];
  failed: { contentType: string; contentId: string; error: string }[];
};

export async function batchDeleteCloudFavorites(items: BatchCloudFavoriteItem[], fetcher: typeof fetch = fetch): Promise<BatchCloudDeleteResult> {
  if (items.length === 0) return { ok: true, succeeded: [], failed: [] };
  try {
    if (syncInFlight) {
      try { await syncInFlight; } catch { /* deletion still gets its own request */ }
    }
    const response = await fetcher('/api/account/favorites/batch-delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: items.map((item) => ({ contentType: item.contentType, contentId: item.contentId })) })
    });
    if (response.status === 401) return { ok: false, succeeded: [], failed: items.map((item) => ({ ...item, error: 'auth' })) };
    if (!response.ok) return { ok: false, succeeded: [], failed: items.map((item) => ({ ...item, error: 'cloud' })) };
    const payload = await response.json() as { ok: boolean; succeeded?: BatchCloudFavoriteItem[]; failed?: { contentType: string; contentId: string; error: string }[] };
    return {
      ok: Boolean(payload.ok),
      succeeded: Array.isArray(payload.succeeded) ? payload.succeeded : [],
      failed: Array.isArray(payload.failed) ? payload.failed : []
    };
  } catch {
    return { ok: false, succeeded: [], failed: items.map((item) => ({ ...item, error: 'network' })) };
  }
}

export async function recordCloudHistory(event: Record<string, unknown>, fetcher: typeof fetch = fetch) {
  try {
    const response = await fetcher('/api/account/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
