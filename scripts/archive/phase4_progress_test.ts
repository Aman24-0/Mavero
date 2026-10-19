import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { clearLocalData, getFavorite, getLocalProgressState, getProgress, listFavorites, listProgress, putFavorite, putProgress, removeFavorite, removeProgress } from '../src/lib/client/progress/database.ts';
import { mergeProgress, progressLabel, progressPercent, saveProgress } from '../src/lib/client/progress/service.ts';
import { completionFor, favoriteKey, progressKey } from '../src/lib/client/progress/types.ts';
import type { WatchProgressRecord } from '../src/lib/client/progress/types.ts';

const snapshot = { title: 'Test title', poster: '/poster.jpg', year: 2026, runtime: '2h', rating: 8, genres: ['Drama'] };
const movie = { contentType: 'movie' as const, contentId: 'test-movie' };
const episode = { contentType: 'series' as const, contentId: 'test-series', season: 2, episode: 4, episodeTitle: 'The test episode' };

await clearLocalData();
assert.equal(progressKey(episode), 'series:test-series:2:4');
assert.equal(favoriteKey('movie', 'test-movie'), 'movie:test-movie');
assert.equal(completionFor(89, 100), 'in_progress');
assert.equal(completionFor(90, 100), 'completed');
assert.equal(progressPercent(await saveProgress({ ...movie, currentTime: 25, duration: 100, snapshot, now: 100 })), 25);

await saveProgress({ ...episode, currentTime: 320, duration: 2640, snapshot, now: 300 });
const fetched = await getProgress(episode);
assert.equal(fetched?.episode, 4);
assert.equal(fetched?.season, 2);
assert.equal(progressLabel(fetched!), 'S02 E04 · 39m left');
assert.equal((await listProgress()).length, 2);

await putFavorite({ key: favoriteKey('movie', 'test-movie'), contentType: 'movie', contentId: 'test-movie', snapshot, createdAt: 1, updatedAt: 2 });
assert.equal((await listFavorites()).length, 1);
assert.equal((await getFavorite('movie', 'test-movie'))?.contentId, 'test-movie');
await removeFavorite('movie', 'test-movie');
assert.equal((await listFavorites()).length, 0);

await removeProgress(movie);
assert.equal(await getProgress(movie), undefined);
const state = await getLocalProgressState();
assert.equal(state.status, 'indexeddb');

const base: WatchProgressRecord = { key: 'movie:merge:-:-', contentType: 'movie', contentId: 'merge', currentTime: 10, duration: 100, completionState: 'in_progress', snapshot, lastWatchedAt: 10, updatedAt: 10 };
const newer = { ...base, currentTime: 35, lastWatchedAt: 20, updatedAt: 20 };
assert.equal(mergeProgress([base], [newer])[0].currentTime, 35);

await clearLocalData();
console.log('Phase 4 progress tests passed');
