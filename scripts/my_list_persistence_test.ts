import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import { mergeFavoriteDeletions, mergeFavorites, mergeFavoritesWithProgress } from '../src/lib/shared/progress-merge.ts';
import { clearLocalData, listFavoriteDeletions, listFavorites, listProgress, putFavorite, putProgress } from '../src/lib/client/progress/database.ts';
import { removeFavoriteFromMyList } from '../src/lib/client/progress/service.ts';
import type { FavoriteDeletionRecord, FavoriteRecord, WatchProgressRecord } from '../src/lib/client/progress/types.ts';

const snapshot = { title: 'Probe', poster: 'https://example.com/probe.jpg' };
const favorite = (updatedAt: number, status: FavoriteRecord['status'] = 'watching'): FavoriteRecord => ({
  key: 'movie:probe', contentType: 'movie', contentId: 'probe', snapshot, createdAt: 100, updatedAt, status,
});
const deletion = (deletedAt: number): FavoriteDeletionRecord => ({
  key: 'movie:probe', contentType: 'movie', contentId: 'probe', deletedAt,
});
const playback = (updatedAt: number): WatchProgressRecord => ({
  key: 'movie:probe:-:-', contentType: 'movie', contentId: 'probe', snapshot,
  currentTime: 42, duration: 100, completionState: 'in_progress', lastWatchedAt: updatedAt, updatedAt,
});

assert.equal(mergeFavoriteDeletions([deletion(200)], [deletion(150)])[0]?.deletedAt, 200, 'latest deletion tombstone must win');
assert.equal(mergeFavorites([favorite(100)], [favorite(90)], [deletion(200)]).length, 0, 'a deletion must suppress stale local and cloud favorites');
assert.equal(mergeFavorites([favorite(250)], [], [deletion(200)]).length, 1, 'a newer explicit add must supersede a deletion');
assert.equal(mergeFavoritesWithProgress([], [playback(300)], [deletion(200)]).length, 0, 'tombstoned progress must not synthesize a My List favorite');
assert.equal(mergeFavoritesWithProgress([], [playback(300)], [deletion(200)])[0], undefined, 'My List result must stay empty after removal');
assert.equal(mergeFavoritesWithProgress([], [playback(300)]).length, 1, 'active progress still derives a watching favorite when no deletion exists');
const continueWatchingProgress = [playback(300)];
assert.equal(continueWatchingProgress[0]?.currentTime, 42, 'playback progress remains available for Continue Watching');
assert.equal(mergeFavorites([favorite(100)], [], [deletion(100)]).length, 0, 'equal timestamps remain deleted');

const favoritesRoute = await readFile(new URL('../src/routes/api/account/favorites/+server.ts', import.meta.url), 'utf8');
assert.match(favoritesRoute, /favorite_deletions/, 'favorites DELETE must persist a tombstone');
assert.doesNotMatch(favoritesRoute, /from\('watch_progress'\)/, 'favorites DELETE must not delete playback progress');
assert.doesNotMatch(favoritesRoute, /watch_history/, 'favorites DELETE must not delete watch history');

await clearLocalData();
await putFavorite(favorite(100));
await putProgress(playback(300));
await removeFavoriteFromMyList('movie', 'probe', 400);
assert.equal((await listFavorites()).length, 0, 'local removal must delete only the favorite relationship');
assert.equal((await listProgress()).length, 1, 'local removal must preserve playback progress');
assert.equal((await listFavoriteDeletions())[0]?.deletedAt, 400, 'local removal must persist a deletion tombstone');
await clearLocalData();

console.log('My List persistence contract tests passed');
