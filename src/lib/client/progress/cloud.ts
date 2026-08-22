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
    const response = await fetcher(`/api/account/favorites?contentType=${encodeURIComponent(contentType)}&contentId=${encodeURIComponent(contentId)}`, { method: 'DELETE' });
    return response.ok;
  } catch {
    return false;
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
