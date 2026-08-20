import { favoriteKey, isFavoriteRecord, isPlaybackRecord, normalizeWatchlistStatus, progressKey, type FavoriteRecord, type LocalProgressState, type PlaybackContext, type SaveProgressInput, type WatchProgressRecord } from './types';

const DB_NAME = 'mavero-local';
const DB_VERSION = 3;
const PROGRESS_STORE = 'watch_progress';
const FAVORITES_STORE = 'favorites';

type StoreName = typeof PROGRESS_STORE | typeof FAVORITES_STORE;

let databasePromise: Promise<IDBDatabase | null> | undefined;
let status: LocalProgressState = { status: 'indexeddb' };
const memoryProgress = new Map<string, WatchProgressRecord>();
const memoryFavorites = new Map<string, FavoriteRecord>();

function canUseIndexedDb() {
  return typeof indexedDB !== 'undefined';
}

function fallback(reason: unknown) {
  status = { status: 'memory', message: reason instanceof Error ? reason.message : 'IndexedDB is unavailable; using temporary memory storage.' };
  return null;
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise;
  if (!canUseIndexedDb()) {
    databasePromise = Promise.resolve(fallback('IndexedDB is not available in this browser.'));
    return databasePromise;
  }

  databasePromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        const progress = db.objectStoreNames.contains(PROGRESS_STORE) ? request.transaction?.objectStore(PROGRESS_STORE) : db.createObjectStore(PROGRESS_STORE, { keyPath: 'key' });
        if (progress) {
          if (!progress.indexNames.contains('lastWatchedAt')) progress.createIndex('lastWatchedAt', 'lastWatchedAt', { unique: false });
          if (!progress.indexNames.contains('contentType')) progress.createIndex('contentType', 'contentType', { unique: false });
          if (!progress.indexNames.contains('updatedAt')) progress.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        const favorites = db.objectStoreNames.contains(FAVORITES_STORE) ? request.transaction?.objectStore(FAVORITES_STORE) : db.createObjectStore(FAVORITES_STORE, { keyPath: 'key' });
        if (favorites) {
          if (!favorites.indexNames.contains('updatedAt')) favorites.createIndex('updatedAt', 'updatedAt', { unique: false });
          if (!favorites.indexNames.contains('createdAt')) favorites.createIndex('createdAt', 'createdAt', { unique: false });
          if (!favorites.indexNames.contains('status')) favorites.createIndex('status', 'status', { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        status = { status: 'indexeddb' };
        resolve(db);
      };
      request.onerror = () => resolve(fallback(request.error));
      request.onblocked = () => resolve(fallback('Local storage upgrade was blocked by another browser tab.'));
    } catch (error) {
      resolve(fallback(error));
    }
  });
  return databasePromise;
}

function request<T>(requestValue: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    requestValue.onsuccess = () => resolve(requestValue.result);
    requestValue.onerror = () => reject(requestValue.error ?? new Error('IndexedDB request failed.'));
  });
}

async function run<T>(storeName: StoreName, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await openDatabase();
  if (!db) return undefined;
  try {
    const transaction = db.transaction(storeName, mode);
    const result = await request(operation(transaction.objectStore(storeName)));
    return result;
  } catch (error) {
    status = { status: 'memory', message: error instanceof Error ? error.message : 'Local storage failed; using temporary memory storage.' };
    return undefined;
  }
}

export async function getLocalProgressState() {
  await openDatabase();
  return status;
}

export async function getProgress(context: PlaybackContext) {
  const key = progressKey(context);
  const result = await run<WatchProgressRecord | undefined>(PROGRESS_STORE, 'readonly', (store) => store.get(key));
  if (result && isPlaybackRecord(result)) return result;
  if (result) await run(PROGRESS_STORE, 'readwrite', (store) => store.delete(key));
  return memoryProgress.get(key);
}

export async function listProgress() {
  const result = await run<unknown[]>(PROGRESS_STORE, 'readonly', (store) => store.getAll());
  if (result) {
    const valid = result.filter(isPlaybackRecord).sort((a, b) => b.lastWatchedAt - a.lastWatchedAt);
    if (valid.length !== result.length) {
      for (const record of result.filter((entry) => !isPlaybackRecord(entry))) {
        const key = record && typeof record === 'object' && 'key' in record && typeof record.key === 'string' ? record.key : undefined;
        if (key) await run(PROGRESS_STORE, 'readwrite', (store) => store.delete(key));
      }
    }
    return valid;
  }
  return [...memoryProgress.values()].sort((a, b) => b.lastWatchedAt - a.lastWatchedAt);
}

export async function putProgress(record: WatchProgressRecord) {
  const safe = { ...record, currentTime: Math.max(0, Number(record.currentTime) || 0), duration: Math.max(0, Number(record.duration) || 0), updatedAt: Number(record.updatedAt) || Date.now(), lastWatchedAt: Number(record.lastWatchedAt) || Date.now() };
  memoryProgress.set(safe.key, safe);
  const result = await run(PROGRESS_STORE, 'readwrite', (store) => store.put(safe));
  return result === undefined && status.status !== 'indexeddb' ? safe : safe;
}

export async function removeProgress(context: PlaybackContext) {
  const key = progressKey(context);
  memoryProgress.delete(key);
  await run(PROGRESS_STORE, 'readwrite', (store) => store.delete(key));
}

function normalizeFavorite(record: FavoriteRecord) {
  return { ...record, status: normalizeWatchlistStatus(record.status) };
}

export async function getFavorite(contentType: FavoriteRecord['contentType'], contentId: string) {
  const key = favoriteKey(contentType, contentId);
  const result = await run<FavoriteRecord | undefined>(FAVORITES_STORE, 'readonly', (store) => store.get(key));
  if (result && isFavoriteRecord(result)) return normalizeFavorite(result);
  const memory = memoryFavorites.get(key);
  return memory ? normalizeFavorite(memory) : undefined;
}

export async function listFavorites() {
  const result = await run<FavoriteRecord[]>(FAVORITES_STORE, 'readonly', (store) => store.getAll());
  if (result) return result.filter(isFavoriteRecord).map(normalizeFavorite).sort((a, b) => b.updatedAt - a.updatedAt);
  return [...memoryFavorites.values()].map(normalizeFavorite).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function putFavorite(record: FavoriteRecord) {
  const safe = normalizeFavorite(record);
  memoryFavorites.set(safe.key, safe);
  await run(FAVORITES_STORE, 'readwrite', (store) => store.put(safe));
  return safe;
}

export async function removeFavorite(contentType: FavoriteRecord['contentType'], contentId: string) {
  const key = favoriteKey(contentType, contentId);
  memoryFavorites.delete(key);
  await run(FAVORITES_STORE, 'readwrite', (store) => store.delete(key));
}

export async function clearLocalData() {
  memoryProgress.clear();
  memoryFavorites.clear();
  await run(PROGRESS_STORE, 'readwrite', (store) => store.clear());
  await run(FAVORITES_STORE, 'readwrite', (store) => store.clear());
}

export { DB_NAME, DB_VERSION, PROGRESS_STORE, FAVORITES_STORE };
