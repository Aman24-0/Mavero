/**
 * Phase 5 — Canonical media/folder service tests.
 *
 * Tests the CanonicalMediaService against the LIVE Supabase database.
 * All test rows are cleaned up at the end — production tables remain
 * empty after the test.
 *
 * Requires environment variables:
 *   PUBLIC_SUPABASE_URL — project URL
 *   PRIVATE_SUPABASE_SERVICE_ROLE_KEY — service-role key (admin access)
 *
 * If these are not set, the test is SKIPPED (not failed).
 */

import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/server/supabase/database.types.ts';
import { CanonicalMediaService, MediaServiceError, sanitizeFolderName, movieCanonicalKey, seriesCanonicalKey, episodeCanonicalKey } from '../src/lib/server/hosting/media/index.ts';

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const supabaseUrl = process.env.PUBLIC_SUPABASE_URL || 'https://whekhqimzrafhsrmswbn.supabase.co';
const serviceKey = process.env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;

if (!serviceKey) {
  console.log('SKIPPED: PRIVATE_SUPABASE_SERVICE_ROLE_KEY not set.');
  process.exit(0);
}

const client = createClient<Database>(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const service = new CanonicalMediaService(client);

// Management API helper for cleanup (SQL DELETE — more reliable than
// PostgREST's DELETE for complex FK relationships).
const PAT = process.env.SUPABASE_PAT || '';
const PROJ_REF = 'whekhqimzrafhsrmswbn';
async function sqlExec(sql: string): Promise<void> {
  if (!PAT) return;
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJ_REF}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) console.log(`  cleanup SQL error: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

async function cleanupAll(): Promise<void> {
  // Delete ALL rows from hosting tables via direct SQL (Management API).
  await sqlExec('DELETE FROM public.media_folders;');
  await sqlExec('DELETE FROM public.media_items;');
}

console.log('=== Phase 5 — Canonical media/folder service tests ===\n');

// ===========================================================================
// 1. Root folders — deterministic singletons
// ===========================================================================

{
  const root1 = await service.ensureRootFolder('movies');
  const root2 = await service.ensureRootFolder('movies');
  ok(root1.id === root2.id, 'Root: Movies root is deterministic (same ID)');
  ok(root1.canonical_key === 'root:movies', 'Root: Movies canonical_key correct');
  ok(root1.name === 'Movies', 'Root: Movies name correct');

  const rootSeries1 = await service.ensureRootFolder('series');
  const rootSeries2 = await service.ensureRootFolder('series');
  ok(rootSeries1.id === rootSeries2.id, 'Root: Series root is deterministic');
  ok(rootSeries1.canonical_key === 'root:series', 'Root: Series canonical_key correct');

  const rootAnime1 = await service.ensureRootFolder('anime');
  const rootAnime2 = await service.ensureRootFolder('anime');
  ok(rootAnime1.id === rootAnime2.id, 'Root: Anime root is deterministic');
  ok(rootAnime1.canonical_key === 'root:anime', 'Root: Anime canonical_key correct');

  ok(root1.id !== rootSeries1.id && root1.id !== rootAnime1.id, 'Root: three different root IDs');
}
console.log('  ok — root folders (deterministic singletons)');

// ===========================================================================
// 2. Movie — ensure + idempotency
// ===========================================================================

{
  const movie1 = await service.ensureMovie({
    tmdbId: '100001',
    title: 'Test Movie 1001',
    year: 2026,
  });
  const movie2 = await service.ensureMovie({
    tmdbId: '100001',
    title: 'Test Movie 1001 (duplicate call)',
    year: 2026,
  });
  ok(movie1.mediaItemId === movie2.mediaItemId, 'Movie: same media_item ID on repeated ensure');
  ok(movie1.folderId === movie2.folderId, 'Movie: same folder ID on repeated ensure');

  // Verify canonical_key.
  const item = await service.getMediaItemByTmdb('100001', 'movie');
  ok(item?.canonical_key === 'movie:tmdb:100001', 'Movie: canonical_key correct');

  // Verify folder tree structure.
  const movieFolder = await service.getFolderByKey('movies:2026:tmdb-100001');
  ok(movieFolder !== null, 'Movie: folder exists');
  const yearFolder = await service.getFolderByKey('movies:2026');
  ok(yearFolder !== null, 'Movie: year folder exists');
}
console.log('  ok — movie ensure + idempotency');

// ===========================================================================
// 3. Series — ensure + idempotency
// ===========================================================================

{
  const series1 = await service.ensureSeries({
    tmdbId: '200001',
    title: 'Test Series 2001',
    year: 2025,
  });
  const series2 = await service.ensureSeries({
    tmdbId: '200001',
    title: 'Test Series 2001 (duplicate)',
    year: 2025,
  });
  ok(series1.mediaItemId === series2.mediaItemId, 'Series: same media_item ID on repeated ensure');
  ok(series1.folderId === series2.folderId, 'Series: same folder ID on repeated ensure');

  const item = await service.getMediaItemByTmdb('200001', 'series');
  ok(item?.canonical_key === 'series:tmdb:200001', 'Series: canonical_key correct');
}
console.log('  ok — series ensure + idempotency');

// ===========================================================================
// 4. Episode — ensure + parent relationship + idempotency
// ===========================================================================

{
  // First ensure the parent series exists.
  await service.ensureSeries({
    tmdbId: '200002',
    title: 'Test Series 2002',
    year: 2024,
  });

  const ep1 = await service.ensureEpisode({
    seriesTmdbId: '200002',
    season: 1,
    episode: 1,
    episodeTitle: 'Pilot',
  });
  const ep2 = await service.ensureEpisode({
    seriesTmdbId: '200002',
    season: 1,
    episode: 1,
    episodeTitle: 'Pilot (duplicate)',
  });
  ok(ep1.mediaItemId === ep2.mediaItemId, 'Episode: same media_item ID on repeated ensure');
  ok(ep1.folderId === ep2.folderId, 'Episode: same folder ID on repeated ensure');

  // Different episode → different IDs.
  const ep3 = await service.ensureEpisode({
    seriesTmdbId: '200002',
    season: 1,
    episode: 2,
    episodeTitle: 'Episode 2',
  });
  ok(ep1.mediaItemId !== ep3.mediaItemId, 'Episode: different episode → different IDs');
  ok(ep1.folderId !== ep3.folderId, 'Episode: different episode → different folder IDs');
}
console.log('  ok — episode ensure + parent + idempotency');

// ===========================================================================
// 5. Anime — canonical hierarchy + idempotency
// ===========================================================================

{
  const anime1 = await service.ensureAnime({
    tmdbId: '300001',
    title: 'Test Anime 3001',
    year: 2025,
  });
  const anime2 = await service.ensureAnime({
    tmdbId: '300001',
    title: 'Test Anime 3001 (duplicate)',
    year: 2025,
  });
  ok(anime1.mediaItemId === anime2.mediaItemId, 'Anime: same media_item ID');
  ok(anime1.folderId === anime2.folderId, 'Anime: same folder ID');

  const ep1 = await service.ensureAnimeEpisode({
    seriesTmdbId: '300001',
    season: 1,
    episode: 1,
    episodeTitle: 'Anime Episode 1',
  });
  const ep2 = await service.ensureAnimeEpisode({
    seriesTmdbId: '300001',
    season: 1,
    episode: 1,
    episodeTitle: 'Anime Episode 1 (dup)',
  });
  ok(ep1.mediaItemId === ep2.mediaItemId, 'Anime episode: same media_item ID');
  ok(ep1.folderId === ep2.folderId, 'Anime episode: same folder ID');

  // Verify anime is under the anime root, NOT the series root.
  const animeFolder = await service.getFolderByKey('anime:tmdb-300001');
  ok(animeFolder !== null, 'Anime: folder exists under anime root');
  const seriesFolder = await service.getFolderByKey('series:tmdb-300001');
  ok(seriesFolder === null, 'Anime: NOT under series root');
}
console.log('  ok — anime hierarchy + idempotency');

// ===========================================================================
// 6. Identity — same TMDB ID → same media, title alone does not merge
// ===========================================================================

{
  await service.ensureMovie({
    tmdbId: '400001',
    title: 'Identity Test Movie',
    year: 2023,
  });

  // Same TMDB ID, different title → SAME media item (title is display only).
  const m2 = await service.ensureMovie({
    tmdbId: '400001',
    title: 'Different Title Same TMDB',
    year: 2023,
  });
  const m1 = await service.getMediaItemByTmdb('400001', 'movie');
  ok(m1?.id === m2.mediaItemId, 'Identity: same TMDB ID → same media item regardless of title');

  // Different TMDB ID → different media items.
  await service.ensureMovie({
    tmdbId: '400002',
    title: 'Identity Test Movie', // Same title!
    year: 2023,
  });
  const m3 = await service.getMediaItemByTmdb('400002', 'movie');
  ok(m3?.id !== m1?.id, 'Identity: different TMDB ID → different media items (title alone does NOT merge)');
}
console.log('  ok — identity (TMDB-based, title-independent)');

// ===========================================================================
// 7. Validation — invalid inputs rejected
// ===========================================================================

{
  // Invalid TMDB ID.
  try { await service.ensureMovie({ tmdbId: 'abc', title: 'Bad', year: 2026 }); assert.fail('Should throw'); }
  catch (e) { ok(e instanceof MediaServiceError && e.code === 'INVALID_TMDB_ID', 'Validation: invalid TMDB ID rejected'); }

  // Invalid year.
  try { await service.ensureMovie({ tmdbId: '500001', title: 'Bad Year', year: 9999 }); assert.fail('Should throw'); }
  catch (e) { ok(e instanceof MediaServiceError && e.code === 'INVALID_YEAR', 'Validation: invalid year rejected'); }

  // Invalid season.
  try { await service.ensureEpisode({ seriesTmdbId: '200002', season: -1, episode: 1 }); assert.fail('Should throw'); }
  catch (e) { ok(e instanceof MediaServiceError && e.code === 'INVALID_SEASON', 'Validation: invalid season rejected'); }

  // Invalid episode.
  try { await service.ensureEpisode({ seriesTmdbId: '200002', season: 1, episode: 0 }); assert.fail('Should throw'); }
  catch (e) { ok(e instanceof MediaServiceError && e.code === 'INVALID_EPISODE', 'Validation: invalid episode rejected'); }

  // Empty title.
  try { await service.ensureMovie({ tmdbId: '500002', title: '', year: 2026 }); assert.fail('Should throw'); }
  catch (e) { ok(e instanceof MediaServiceError && e.code === 'INVALID_TITLE', 'Validation: empty title rejected'); }

  // Episode without parent series.
  try { await service.ensureEpisode({ seriesTmdbId: '999999', season: 1, episode: 1 }); assert.fail('Should throw'); }
  catch (e) { ok(e instanceof MediaServiceError && e.code === 'PARENT_NOT_FOUND', 'Validation: episode without parent rejected'); }
}
console.log('  ok — validation (invalid inputs rejected)');

// ===========================================================================
// 8. Naming — problematic titles sanitized
// ===========================================================================

{
  ok(sanitizeFolderName('Movie: The Sequel / Part 2') === 'Movie- The Sequel - Part 2', 'Naming: colon + slash sanitized');
  ok(sanitizeFolderName('  .Hidden.  ') === 'Hidden', 'Naming: leading/trailing dots + spaces removed');
  ok(sanitizeFolderName('日本語タイトル') === '日本語タイトル', 'Naming: unicode preserved');
  ok(sanitizeFolderName(null) === 'Untitled', 'Naming: null → Untitled');
  ok(sanitizeFolderName('   ') === 'Untitled', 'Naming: whitespace-only → Untitled');

  const longTitle = 'A'.repeat(250);
  const sanitized = sanitizeFolderName(longTitle);
  ok(sanitized.length <= 180, `Naming: long title truncated to ≤180 chars (got ${sanitized.length})`);

  // Ensure a movie with problematic title can be created.
  const movie = await service.ensureMovie({
    tmdbId: '600001',
    title: 'Movie: The Sequel / Part 2',
    year: 2026,
  });
  ok(movie.mediaItemId, 'Naming: movie with problematic title created');

  // Verify the folder name is sanitized (NOT the media_items.title).
  const folder = await service.getFolderByKey('movies:2026:tmdb-600001');
  ok(folder?.name === 'Movie- The Sequel - Part 2', `Naming: folder name sanitized (got "${folder?.name}")`);

  // Verify media_items.title is preserved.
  const item = await service.getMediaItemByKey('movie:tmdb:600001');
  ok(item?.title === 'Movie: The Sequel / Part 2', 'Naming: media_items.title preserved (NOT sanitized)');
}
console.log('  ok — naming (sanitization + unicode + long title)');

// ===========================================================================
// 9. Canonical key generation — deterministic
// ===========================================================================

{
  ok(movieCanonicalKey('12345') === 'movie:tmdb:12345', 'Key: movie canonical key');
  ok(seriesCanonicalKey('1399') === 'series:tmdb:1399', 'Key: series canonical key');
  ok(episodeCanonicalKey('1399', 1, 1) === 'series:tmdb:1399:s1:e1', 'Key: episode canonical key');
  ok(episodeCanonicalKey('1399', 10, 99) === 'series:tmdb:1399:s10:e99', 'Key: episode canonical key (double-digit)');
}
console.log('  ok — canonical key generation');

// ===========================================================================
// 10. Cleanup — verify no rows left in production
// ===========================================================================

await cleanupAll();

// Verify via Management API SQL (more reliable than PostgREST count).
const verifyRes = await fetch(`https://api.supabase.com/v1/projects/${PROJ_REF}/database/query`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'SELECT (SELECT count(*) FROM public.media_items)::int AS mi, (SELECT count(*) FROM public.media_folders)::int AS mf;' }),
});
const verifyData = await verifyRes.json() as Array<{ mi: number; mf: number }>;
ok(verifyData[0].mi === 0, `Cleanup: 0 media_items remaining (got ${verifyData[0].mi})`);
ok(verifyData[0].mf === 0, `Cleanup: 0 media_folders remaining (got ${verifyData[0].mf})`);

console.log('  ok — cleanup (all test rows removed via Management API SQL)');

console.log(`\nPhase 5 canonical folder service tests: ${passed} checks passed.`);
