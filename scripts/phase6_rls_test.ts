import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
assert.ok(url && key, 'Supabase public environment is required');

const userA = '3e7181a3-3999-4844-92bf-4f0afbc5b70f';
const userB = 'c6c5d5a1-0b2c-4a6a-8c1e-9f9c7a5e3b11';
const client = createClient(url, key);
const { data: signedIn, error: signInError } = await client.auth.signInWithPassword({ email: 'mavero.rls.fixture.b@invalid.example', password: 'MaveroRlsFixture-2026!' });
assert.equal(signInError, null, `fixture User B sign-in failed: ${signInError?.message ?? 'unknown error'}`);
assert.equal(signedIn.user?.id, userB, 'fixture User B identity mismatch');

const ownProfile = await client.from('profiles').select('id,display_name,role').eq('id', userB).limit(1);
assert.equal(ownProfile.error, null, 'User B should read own profile');
assert.equal(ownProfile.data?.[0]?.id, userB, 'User B profile row missing');

const ownProgressKey = 'movie:rls-fixture-b:-:-';
const ownFavoriteKey = 'movie:rls-fixture-b';
const ownHistoryKey = 'movie:rls-fixture-b:-:-:started:8';
const cleanupProgress = await client.from('watch_progress').delete().eq('user_id', userB).eq('progress_key', ownProgressKey);
assert.equal(cleanupProgress.error, null, 'User B fixture progress cleanup failed');
const cleanupFavorite = await client.from('favorites').delete().eq('user_id', userB).eq('favorite_key', ownFavoriteKey);
assert.equal(cleanupFavorite.error, null, 'User B fixture favorite cleanup failed');
const cleanupHistory = await client.from('watch_history').delete().eq('user_id', userB).eq('event_key', ownHistoryKey);
assert.equal(cleanupHistory.error, null, 'User B fixture history cleanup failed');

const ownProgressInsert = await client.from('watch_progress').insert({ user_id: userB, progress_key: ownProgressKey, content_type: 'movie', content_id: 'rls-fixture-b', position_seconds: 8, duration: 100, completion_state: 'in_progress', snapshot: { title: 'RLS Fixture B', poster: 'https://example.com/fixture-b.jpg' } }).select('progress_key').limit(1);
assert.equal(ownProgressInsert.error, null, 'User B should write own progress');
const ownProgressRead = await client.from('watch_progress').select('progress_key,position_seconds').eq('user_id', userB).eq('progress_key', ownProgressKey).limit(1);
assert.equal(ownProgressRead.error, null, 'User B should read own progress');
assert.equal(ownProgressRead.data?.[0]?.position_seconds, 8, 'User B progress position mismatch');

const ownFavoriteInsert = await client.from('favorites').insert({ user_id: userB, favorite_key: ownFavoriteKey, content_type: 'movie', content_id: 'rls-fixture-b', snapshot: { title: 'RLS Fixture B', poster: 'https://example.com/fixture-b.jpg' } }).select('favorite_key').limit(1);
assert.equal(ownFavoriteInsert.error, null, 'User B should write own favorite');
const ownFavoriteRead = await client.from('favorites').select('favorite_key').eq('user_id', userB).eq('favorite_key', ownFavoriteKey).limit(1);
assert.equal(ownFavoriteRead.error, null, 'User B should read own favorite');
assert.equal(ownFavoriteRead.data?.[0]?.favorite_key, ownFavoriteKey, 'User B favorite missing');

const ownHistoryInsert = await client.from('watch_history').insert({ user_id: userB, event_key: ownHistoryKey, event_type: 'started', content_type: 'movie', content_id: 'rls-fixture-b', position_seconds: 8, duration: 100, completion_state: 'in_progress', snapshot: { title: 'RLS Fixture B', poster: 'https://example.com/fixture-b.jpg' } }).select('event_key').limit(1);
assert.equal(ownHistoryInsert.error, null, 'User B should write own history');
const ownHistoryRead = await client.from('watch_history').select('event_key').eq('user_id', userB).eq('event_key', ownHistoryKey).limit(1);
assert.equal(ownHistoryRead.error, null, 'User B should read own history');
assert.equal(ownHistoryRead.data?.[0]?.event_key, ownHistoryKey, 'User B history missing');

const aProgressRead = await client.from('watch_progress').select('progress_key').eq('user_id', userA).limit(10);
assert.equal(aProgressRead.error, null, 'Cross-user progress reads should be safely filtered');
assert.equal(aProgressRead.data?.length ?? 0, 0, 'User B must not read User A progress');
const aFavoriteRead = await client.from('favorites').select('favorite_key').eq('user_id', userA).limit(10);
assert.equal(aFavoriteRead.error, null, 'Cross-user favorite reads should be safely filtered');
assert.equal(aFavoriteRead.data?.length ?? 0, 0, 'User B must not read User A favorites');
const aHistoryRead = await client.from('watch_history').select('event_key').eq('user_id', userA).limit(10);
assert.equal(aHistoryRead.error, null, 'Cross-user history reads should be safely filtered');
assert.equal(aHistoryRead.data?.length ?? 0, 0, 'User B must not read User A history');

const aProgressWrite = await client.from('watch_progress').insert({ user_id: userA, progress_key: 'movie:rls-forbidden-b:-:-', content_type: 'movie', content_id: 'rls-forbidden-b', position_seconds: 1, duration: 100, completion_state: 'in_progress', snapshot: { title: 'Forbidden', poster: 'https://example.com/forbidden.jpg' } });
assert.ok(aProgressWrite.error, 'User B must not write User A progress');
const aFavoriteWrite = await client.from('favorites').insert({ user_id: userA, favorite_key: 'movie:rls-forbidden-b', content_type: 'movie', content_id: 'rls-forbidden-b', snapshot: { title: 'Forbidden', poster: 'https://example.com/forbidden.jpg' } });
assert.ok(aFavoriteWrite.error, 'User B must not write User A favorites');
const aProfileWrite = await client.from('profiles').update({ display_name: 'Forbidden Cross User Mutation' }).eq('id', userA).select('id').limit(1);
assert.equal(aProfileWrite.error, null, 'Filtered profile update should not leak a database error');
assert.equal(aProfileWrite.data?.length ?? 0, 0, 'User B must not modify User A profile');

await client.auth.signOut();
console.log('Phase 6 authenticated User B RLS isolation test passed');
