import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isCloudHistoryEvent } from '../src/lib/server/supabase/records.ts';
import { readJsonBody } from '../src/lib/server/http/body.ts';
import { isFavoriteRecord, isPlaybackRecord } from '../src/lib/client/progress/types.ts';

const snapshot = { title: 'Audit fixture', poster: 'https://example.com/poster.jpg' };
const progress = {
  key: 'movie:audit-fixture:-:-', contentType: 'movie' as const, contentId: 'audit-fixture',
  currentTime: 40, duration: 100, completionState: 'in_progress' as const,
  snapshot, lastWatchedAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
};
const favorite = {
  key: 'movie:audit-fixture', contentType: 'movie' as const, contentId: 'audit-fixture',
  snapshot, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, status: 'watching' as const,
};
const historyEvent = {
  eventKey: 'movie:audit-fixture:-:-:started:40', eventType: 'started' as const,
  contentType: 'movie' as const, contentId: 'audit-fixture', currentTime: 40, duration: 100,
  completionState: 'in_progress' as const, snapshot, occurredAt: 1_700_000_000_000,
};

assert.equal(isPlaybackRecord(progress), true, 'valid playback records should pass validation');
assert.equal(isPlaybackRecord({ ...progress, key: 'movie:other:-:-' }), false, 'playback key must match its identity');
assert.equal(isPlaybackRecord({ ...progress, currentTime: Number.NaN }), false, 'non-finite playback values must be rejected');
assert.equal(isFavoriteRecord(favorite), true, 'valid favorite records should pass validation');
assert.equal(isFavoriteRecord({ ...favorite, key: 'series:audit-fixture' }), false, 'favorite key must match its identity');
assert.equal(isCloudHistoryEvent(historyEvent), true, 'valid history events should pass validation');
assert.equal(isCloudHistoryEvent({ ...historyEvent, contentType: 'movie', season: 1, episode: 1 }), false, 'movie history cannot carry episode context');
assert.equal(isCloudHistoryEvent({ ...historyEvent, snapshot: { title: 'x', poster: 'x', description: 'x'.repeat(4_001) } }), false, 'oversized snapshots must be rejected');

const malformed = await readJsonBody<{ ok: boolean }>(new Request('https://mavero.test/api', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } }));
assert.equal(malformed.ok, false, 'malformed JSON should be rejected');
if (!malformed.ok) assert.equal(malformed.status, 400);
const oversized = await readJsonBody<{ ok: boolean }>(new Request('https://mavero.test/api', { method: 'POST', body: 'x'.repeat(300), headers: { 'content-type': 'application/json' } }), 128);
assert.equal(oversized.ok, false, 'oversized JSON should be rejected');
if (!oversized.ok) assert.equal(oversized.status, 413);

const historyRoute = await readFile(new URL('../src/routes/api/account/history/+server.ts', import.meta.url), 'utf8');
const syncRoute = await readFile(new URL('../src/routes/api/account/sync/+server.ts', import.meta.url), 'utf8');
const netlify = await readFile(new URL('../netlify.toml', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20260823080000_harden_favorite_deletion_rls.sql', import.meta.url), 'utf8');
assert.match(historyRoute, /readJsonBody/);
assert.match(historyRoute, /isCloudHistoryEvent/);
assert.match(syncRoute, /isPlaybackRecord/);
assert.match(syncRoute, /MAX_SYNC_BODY_BYTES/);
assert.match(netlify, /X-Content-Type-Options = "nosniff"/);
assert.match(netlify, /X-Frame-Options = "DENY"/);
assert.match(migration, /select auth\.uid\(\)/);

console.log('Release audit regression tests passed');
