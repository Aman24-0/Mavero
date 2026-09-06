import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { mergeFavorites, mergeProgress } from '../src/lib/shared/progress-merge.ts';
import type { FavoriteRecord, WatchProgressRecord } from '../src/lib/client/progress/types.ts';

const snapshot = { title: 'Probe', poster: 'https://example.com/probe.jpg' };
const progress = (key: string, updatedAt: number, currentTime: number, extra: Partial<WatchProgressRecord> = {}): WatchProgressRecord => ({
  key,
  contentType: extra.contentType ?? 'movie',
  contentId: extra.contentId ?? 'probe',
  currentTime,
  duration: 100,
  completionState: 'in_progress',
  snapshot,
  lastWatchedAt: updatedAt,
  updatedAt,
  ...extra,
});
const favorite = (key: string, updatedAt: number): FavoriteRecord => ({ key, contentType: 'movie', contentId: 'probe', snapshot, createdAt: updatedAt - 100, updatedAt });

const local = progress('movie:probe:-:-', 100, 12);
const cloud = progress('movie:probe:-:-', 200, 42);
assert.equal(mergeProgress([local], [cloud])[0]?.currentTime, 42, 'newer cloud progress should win');
assert.equal(mergeProgress([progress('movie:probe:-:-', 200, 10)], [progress('movie:probe:-:-', 200, 18)])[0]?.currentTime, 18, 'equal timestamps should use the greater position');
assert.equal(mergeProgress([progress('series:show:2:4', 200, 18, { contentType: 'series', contentId: 'show', season: 2, episode: 4 })], [progress('series:show:2:5', 210, 3, { contentType: 'series', contentId: 'show', season: 2, episode: 5 })]).length, 2, 'episode contexts must remain distinct');
assert.equal(mergeFavorites([favorite('movie:probe', 100)], [favorite('movie:probe', 200)])[0]?.updatedAt, 200, 'newer favorite should win');

const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
assert.ok(url && key, 'Supabase public environment is required');
const supabase = createClient(url, key);
const anonymousRead = await supabase.from('watch_progress').select('progress_key').limit(1);
assert.equal(anonymousRead.error, null, 'anonymous select should be safely filtered by RLS');
assert.equal(anonymousRead.data?.length ?? 0, 0, 'anonymous users must not see protected progress');
const anonymousWrite = await supabase.from('watch_progress').insert({ user_id: '00000000-0000-0000-0000-000000000000', progress_key: 'movie:rls-probe:-:-', content_type: 'movie', content_id: 'rls-probe', position_seconds: 1, duration: 100, completion_state: 'in_progress', snapshot });
assert.ok(anonymousWrite.error, 'anonymous insert must be denied by RLS');

const response = await fetch('http://localhost:3000/api/account/sync');
assert.equal(response.status, 401, 'server sync endpoint must reject signed-out requests');

console.log('Phase 5 cloud contract and unauthenticated RLS tests passed');
