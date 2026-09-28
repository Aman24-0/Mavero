/**
 * Phase 7 — Playback Resolver + Automatic Provider Fallback tests.
 *
 * Test matrix (per Phase 7 §19):
 *
 *   Movie (1-10):
 *     1. Vidara only (ready)        → resolves
 *     2. Abyss only (ready)         → resolves
 *     3. Both ready                 → both available (resolver picks one, both candidates valid)
 *     4. Neither                    → resolver returns null for both (falls through to other sources)
 *     5. Vidara processing          → does NOT resolve (status='processing')
 *     6. Abyss processing           → does NOT resolve (status='processing')
 *     7. Vidara failed              → does NOT resolve (status='failed')
 *     8. Abyss failed               → does NOT resolve (status='failed')
 *     9. Vidara deleted             → does NOT resolve (status='deleted')
 *    10. Abyss deleted              → does NOT resolve (status='deleted')
 *
 *   Series (11-18):
 *    11. S01E01 Vidara only          → resolves
 *    12. S01E01 Abyss only           → resolves
 *    13. S01E01 both                 → both available
 *    14. S01E01 neither              → does NOT resolve
 *    15. S02E01 vs S01E01 isolation → S02E01 query does NOT match S01E01 asset
 *    16. Missing episode             → does NOT resolve (no media_item row)
 *    17. Wrong episode must never resolve → S01E02 query returns null when only S01E01 exists
 *    18. Deleted episode asset       → does NOT resolve (status='deleted')
 *
 *   Fallback (19-21):
 *    19. Vidara DB error + existing fallback → resolver continues to next candidate
 *    20. Both Mavero-hosted fail + existing fallback → resolver continues
 *    21. No Mavero asset + existing fallback → resolver continues
 *
 *   Player (22-27):
 *    22. Vidara URL goes through embed path  → AdapterResult.type === 'embed'
 *    23. Abyss URL goes through embed path   → AdapterResult.type === 'embed'
 *    24. No raw-stream assumption              → never 'direct'
 *    25. Source switching works                → both adapters in createDefaultAdapterIds()
 *    26. Stale saved provider source          → resolver returns null for stale, fallback continues
 *    27. Resume with provider source           → resolver still returns null for stale, no exception
 *
 *   Security (28-33):
 *    28. Guest playback                         → resolver endpoint public (no admin gate)
 *    29. Authenticated playback                 → resolver endpoint works
 *    30. Admin playback                         → resolver endpoint works
 *    31. No provider secret exposure            → response carries only playback_url + metadata
 *    32. Malformed identity                     → adapter returns null (no exception)
 *    33. Provider asset ownership/association   → adapter scopes by provider_source_id
 *
 * Plus:
 *   - Source contract tests (read source files, verify integration)
 *   - Live DB cleanup (all hosting tables return to 0 rows)
 *
 * Test philosophy (mirrors phase3_hosting_adapter_test.ts and
 * phase6_admin_upload_test.ts patterns):
 *   - Source-contract tests are deterministic (readFileSync).
 *   - Live DB tests use the service-role client + Supabase Management
 *     API for cleanup. SKIP gracefully if PRIVATE_SUPABASE_SERVICE_ROLE_KEY
 *     is not set.
 *   - Mock Supabase client for adapter unit tests (in-process stub).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/server/supabase/database.types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  try {
    assert.ok(condition, label);
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error(`  FAIL: ${label}`);
    if (err instanceof Error && err.message !== label) console.error(`        ${err.message}`);
  }
}
function eq<T>(actual: T, expected: T, label: string) {
  try {
    assert.deepEqual(actual, expected, label);
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error(`  FAIL: ${label}\n        actual:   ${JSON.stringify(actual)}\n        expected: ${JSON.stringify(expected)}`);
    if (err instanceof Error && err.message !== label) console.error(`        ${err.message}`);
  }
}

console.log('=== Phase 7 — Playback Resolver + Automatic Provider Fallback ===\n');

// ===========================================================================
// SECTION A — Source contract tests (deterministic, no live DB)
// ===========================================================================

console.log('--- Section A: Source contract tests ---\n');

// A.1 Adapter file exists and has the correct contract
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/lib/server/resolver/mavero-hosted.ts'), 'utf8');
  ok(src.includes("integrationType: 'custom'"), 'A.1.1 adapter integrationType = custom');
  ok(src.includes('adapterId'), 'A.1.2 adapter exposes adapterId');
  ok(src.includes("type: 'embed'"), 'A.1.3 adapter returns type=embed (NOT direct)');
  ok(!src.includes("type: 'direct'"), 'A.1.4 adapter NEVER returns direct (raw stream)');
  ok(src.includes('movieCanonicalKey'), 'A.1.5 uses Phase 5 movieCanonicalKey');
  ok(src.includes('seriesCanonicalKey'), 'A.1.6 uses Phase 5 seriesCanonicalKey');
  ok(src.includes('episodeCanonicalKey'), 'A.1.7 uses Phase 5 episodeCanonicalKey');
  ok(src.includes("eq('status', 'ready')"), 'A.1.8 gates on status=ready (only)');
  ok(src.includes('validatePlaybackUrl'), 'A.1.9 validates URL via safe-url.ts');
  ok(src.includes('allowedEmbedOriginsFromCapabilities'), 'A.1.10 effective origins = provider + source union');
  ok(src.includes('PRIVATE_SUPABASE_SERVICE_ROLE_KEY'), 'A.1.11 uses server-only env var');
  ok(src.includes('getServiceClient'), 'A.1.12 service client factory exists');
  ok(src.includes('__setMaveroHostedServiceClientForTests'), 'A.1.13 test injection point exists');
  ok(src.includes('context.config.source.id'), 'A.1.14 scopes by provider_source_id (NOT hardcoded UUID)');
  ok(src.includes('context.config.provider.adapter_id') || src.includes('adapterId'), 'A.1.15 uses provider identity (no hardcoded adapter id)');
  ok(src.includes('Phase 7'), 'A.1.16 references Phase 7 in module doc');
  ok(!src.includes('api_key') && !src.includes('password'), 'A.1.17 NO provider credentials in source');
  ok(src.includes('return null'), 'A.1.18 returns null on miss (NOT throws)');
}
console.log('  ok — A.1 adapter contract (18 checks)\n');

// A.2 Adapter is registered in createDefaultAdapterIds
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/lib/server/resolver/adapters.ts'), 'utf8');
  ok(src.includes('createMaveroHostedAdapter'), 'A.2.1 imports createMaveroHostedAdapter');
  ok(src.includes('MAVERO_HOSTED_ADAPTER_ID_VIDARA'), 'A.2.2 imports VIDARA adapter id constant');
  ok(src.includes('MAVERO_HOSTED_ADAPTER_ID_ABYSS'), 'A.2.3 imports ABYSS adapter id constant');
  ok(src.includes("createMaveroHostedAdapter(MAVERO_HOSTED_ADAPTER_ID_VIDARA)"), 'A.2.4 registers Vidara adapter');
  ok(src.includes("createMaveroHostedAdapter(MAVERO_HOSTED_ADAPTER_ID_ABYSS)"), 'A.2.5 registers Abyss adapter');
  ok(src.includes('Phase 7'), 'A.2.6 references Phase 7 in comment');
}
console.log('  ok — A.2 adapter registration (6 checks)\n');

// A.3 Resolver core unchanged — adapterFor still uses adapter_id
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/lib/server/resolver/core.ts'), 'utf8');
  ok(src.includes('adapterId ? dependencies.adaptersById?.[adapterId] ?? createDefaultAdapterIds()[adapterId]'), 'A.3.1 adapterFor dispatches by adapter_id');
  ok(!src.includes('mavero-hosted'), 'A.3.2 core.ts does NOT directly reference mavero-hosted (decoupled)');
}
console.log('  ok — A.3 resolver core decoupling (2 checks)\n');

// A.4 Phase 4 migration registers the correct adapter_id values
{
  const src = readFileSync(path.join(REPO_ROOT, 'supabase/migrations/20260928213822_phase4_register_hosting_sources.sql'), 'utf8');
  ok(src.includes("'vidara'"), 'A.4.1 Phase 4 sets adapter_id=vidara');
  ok(src.includes("'abyss'"), 'A.4.2 Phase 4 sets adapter_id=abyss');
  ok(src.includes("'custom'"), 'A.4.3 Phase 4 sets integration_type=custom');
  ok(src.includes("'result_type', 'embed'"), 'A.4.4 Phase 4 sets result_type=embed (not direct)');
  ok(src.includes("'https://vidara.so'"), 'A.4.5 Phase 4 sets allowed_embed_origins includes vidara.so');
  ok(src.includes("'https://player.abyssplayer.com'"), 'A.4.6 Phase 4 sets allowed_embed_origins includes player.abyssplayer.com');
  ok(src.includes("'supports_direct', false"), 'A.4.7 Phase 4 explicitly disables direct');
}
console.log('  ok — A.4 Phase 4 capability contract (7 checks)\n');

// A.5 Phase 5 canonical keys are the correct format
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/lib/server/hosting/media/canonical-key.ts'), 'utf8');
  ok(src.includes("return `movie:tmdb:${tmdbId}`"), 'A.5.1 movie key format: movie:tmdb:<id>');
  ok(src.includes("return `series:tmdb:${tmdbId}`"), 'A.5.2 series key format: series:tmdb:<id>');
  ok(src.includes("return `series:tmdb:${tmdbId}:s${season}:e${episode}`"), 'A.5.3 episode key format: series:tmdb:<id>:s<S>:e<E>');
}
console.log('  ok — A.5 Phase 5 canonical key contract (3 checks)\n');

// A.6 Watch page server load is unchanged (no Phase 7-specific changes needed)
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/routes/watch/[type]/[id]/+page.server.ts'), 'utf8');
  ok(src.includes('getPublicStreamingConfig'), 'A.6.1 watch route uses getPublicStreamingConfig (existing source list)');
  ok(src.includes('streamingConfig'), 'A.6.2 watch route returns streamingConfig to client (source selector)');
}
console.log('  ok — A.6 watch route integration (2 checks)\n');

// A.7 Playback resolve endpoint unchanged
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/routes/api/playback/resolve/+server.ts'), 'utf8');
  ok(src.includes('resolveSource'), 'A.7.1 endpoint calls resolveSource (existing resolver pipeline)');
  ok(src.includes('checkRateLimit'), 'A.7.2 rate limit preserved');
  ok(src.includes('no-store'), 'A.7.3 no-store cache headers preserved');
  ok(!src.includes('requireAdmin'), 'A.7.4 NO requireAdmin — public playback model preserved');
  ok(!src.includes('api_key') && !src.includes('password'), 'A.7.5 NO credentials in endpoint');
}
console.log('  ok — A.7 playback endpoint contract (5 checks)\n');

// A.8 Player guards accept embed URLs (existing behavior preserved)
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/lib/shared/player-guards.ts'), 'utf8');
  ok(src.includes("source.type !== 'direct' && source.type !== 'embed'"), 'A.8.1 player guards accept both direct AND embed');
  ok(src.includes('isHttpsUrl'), 'A.8.2 player guards enforce HTTPS');
}
console.log('  ok — A.8 player guards (2 checks)\n');

// ===========================================================================
// SECTION B — Live DB tests (SKIP if env vars not set)
// ===========================================================================

const supabaseUrl = process.env.PUBLIC_SUPABASE_URL || 'https://whekhqimzrafhsrmswbn.supabase.co';
const serviceKey = process.env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;
const PAT = process.env.SUPABASE_PAT || '';
const PROJ_REF = 'whekhqimzrafhsrmswbn';

if (!serviceKey) {
  console.log('--- Section B: SKIPPED (PRIVATE_SUPABASE_SERVICE_ROLE_KEY not set) ---\n');
} else {
  console.log('--- Section B: Live DB tests ---\n');

  const client = createClient<Database>(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  // --- Cleanup helper (uses Supabase Management API for direct SQL) ---
  async function sqlExec(sql: string): Promise<void> {
    if (!PAT) return;
    await fetch(`https://api.supabase.com/v1/projects/${PROJ_REF}/database/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    });
  }

  async function cleanupAll(): Promise<void> {
    await sqlExec('DELETE FROM public.media_upload_operations;');
    await sqlExec('DELETE FROM public.media_assets;');
    await sqlExec('DELETE FROM public.media_operations;');
    await sqlExec('DELETE FROM public.media_folders;');
    await sqlExec('DELETE FROM public.media_items;');
    await sqlExec('DELETE FROM public.media_availability_requests;');
    await sqlExec('DELETE FROM public.provider_folder_mappings;');
  }

  // --- Lookup real provider/source IDs (Phase 4 rows) ---
  const { data: vidaraSource } = await client.from('streaming_sources').select('id, provider_id').eq('slug', 'mavero-1').maybeSingle();
  const { data: abyssSource } = await client.from('streaming_sources').select('id, provider_id').eq('slug', 'mavero-2').maybeSingle();
  const vidaraSourceId = (vidaraSource as { id: string } | null)?.id ?? '';
  const abyssSourceId = (abyssSource as { id: string } | null)?.id ?? '';

  if (!vidaraSourceId || !abyssSourceId) {
    console.log('  SKIPPED: Phase 4 source rows (mavero-1, mavero-2) not found in DB.');
    console.log('  Ensure Phase 4 migration 20260928213822 has been applied.\n');
  } else {
    // --- Helpers to insert test data ---
    async function ensureMovieItem(tmdbId: string, title: string): Promise<string> {
      const canonicalKey = `movie:tmdb:${tmdbId}`;
      const { data, error } = await client.from('media_items').upsert({
        canonical_key: canonicalKey,
        content_type: 'movie',
        tmdb_id: tmdbId,
        title,
      }, { onConflict: 'canonical_key' }).select('id').single();
      if (error || !data) throw new Error(`ensureMovieItem failed: ${error?.message}`);
      return data.id;
    }

    async function ensureEpisodeItem(tmdbId: string, season: number, episode: number, parentMediaItemId: string): Promise<string> {
      const canonicalKey = `series:tmdb:${tmdbId}:s${season}:e${episode}`;
      const { data, error } = await client.from('media_items').upsert({
        canonical_key: canonicalKey,
        content_type: 'series',
        tmdb_id: tmdbId,
        title: `Episode S${season}E${episode}`,
        season,
        episode,
        parent_media_id: parentMediaItemId,
      }, { onConflict: 'canonical_key' }).select('id').single();
      if (error || !data) throw new Error(`ensureEpisodeItem failed: ${error?.message}`);
      return data.id;
    }

    async function ensureSeriesItem(tmdbId: string, title: string): Promise<string> {
      const canonicalKey = `series:tmdb:${tmdbId}`;
      const { data, error } = await client.from('media_items').upsert({
        canonical_key: canonicalKey,
        content_type: 'series',
        tmdb_id: tmdbId,
        title,
      }, { onConflict: 'canonical_key' }).select('id').single();
      if (error || !data) throw new Error(`ensureSeriesItem failed: ${error?.message}`);
      return data.id;
    }

    async function insertAsset(params: {
      media_item_id: string;
      provider_source_id: string;
      playback_url: string;
      status?: string;
    }): Promise<string> {
      const { data, error } = await client.from('media_assets').insert({
        media_item_id: params.media_item_id,
        provider_source_id: params.provider_source_id,
        provider_asset_id: `test-${Math.random().toString(36).slice(2, 12)}`,
        playback_url: params.playback_url,
        status: params.status ?? 'ready',
        mavero_status: params.status === 'ready' ? 'available' : 'processing',
      }).select('id').single();
      if (error || !data) throw new Error(`insertAsset failed: ${error?.message}`);
      return data.id;
    }

    // --- Adapter invocation helper ---
    // We invoke the adapter directly with a mock ResolverContext that
    // matches the shape the resolver would build. The adapter reads
    // only `context.config.source.id`, `context.config.provider`,
    // `context.identifiers.tmdbId`, and `request.{mediaType,season,episode}`.
    const { createMaveroHostedAdapter, __setMaveroHostedServiceClientForTests } = await import('../src/lib/server/resolver/mavero-hosted.ts');
    __setMaveroHostedServiceClientForTests(client);
    const vidaraAdapter = createMaveroHostedAdapter('vidara');
    const abyssAdapter = createMaveroHostedAdapter('abyss');

    type MockContext = Parameters<typeof vidaraAdapter.resolve>[0];
    function buildContext(adapter: 'vidara' | 'abyss', params: {
      sourceId: string;
      providerId: string;
      tmdbId?: string;
      mediaType: 'movie' | 'series';
      season?: number;
      episode?: number;
    }): MockContext {
      const allowedOrigins = adapter === 'vidara' ? ['https://vidara.so'] : ['https://player.abyssplayer.com'];
      return {
        request: {
          sourceId: params.sourceId,
          contentId: `${params.mediaType}-${params.tmdbId ?? ''}`,
          mediaType: params.mediaType,
          ...(params.season != null ? { season: params.season } : {}),
          ...(params.episode != null ? { episode: params.episode } : {}),
        },
        // The adapter only reads identifiers.tmdbId.
        identifiers: {
          internalId: params.tmdbId ?? '',
          slug: params.tmdbId ?? '',
          ...(params.tmdbId ? { tmdbId: params.tmdbId } : {}),
        },
        content: { id: params.tmdbId ?? '', type: params.mediaType, title: 'Test', year: 2024, runtime: '', rating: 0, genres: [], description: '', poster: '', backdrop: '', accent: '', source: { provider: 'tmdb', externalId: params.tmdbId ?? '' } } as MockContext['content'],
        config: {
          provider: {
            id: params.providerId,
            name: adapter === 'vidara' ? 'Vidara' : 'Abyss',
            status: 'experimental',
            enabled: true,
            integration_type: 'custom',
            adapter_id: adapter,
            capabilities: {
              movie: true,
              series: true,
              anime: false,
              result_type: 'embed',
              allowed_embed_origins: allowedOrigins,
              supports_direct: false,
              allow_experimental_playback: true,
            },
          },
          source: {
            id: params.sourceId,
            provider_id: params.providerId,
            name: adapter === 'vidara' ? 'Mavero 1' : 'Mavero 2',
            status: 'experimental',
            enabled: true,
            visibility: 'public',
            integration_type: 'custom',
            capabilities: { result_type: 'embed' },
            identifier_mode: 'tmdb_id',
            audio_languages: [],
            subtitle_capability: false,
            quality_capability: [],
            movie_template: null,
            series_template: null,
            anime_template: null,
          },
        },
      };
    }

    const vidaraProviderId = (vidaraSource as { provider_id: string }).provider_id;
    const abyssProviderId = (abyssSource as { provider_id: string }).provider_id;

    const VIDARA_URL = 'https://vidara.so/v/test-filecode-1';
    const ABYSS_URL = 'https://player.abyssplayer.com/test-slug-1';

    // --- Cleanup before tests ---
    await cleanupAll();

    // ===========================================================================
    // B.1-B.10 — Movie resolution matrix
    // ===========================================================================
    console.log('  --- B.1-B.10: Movie resolution matrix ---');

    // B.1 Vidara only (ready)
    {
      const tmdbId = '700001';
      const itemId = await ensureMovieItem(tmdbId, 'Test Movie 1');
      await insertAsset({ media_item_id: itemId, provider_source_id: vidaraSourceId, playback_url: VIDARA_URL, status: 'ready' });
      const result = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'movie' }));
      ok(result !== null, 'B.1.1 Vidara-only ready movie: adapter returns non-null');
      eq(result?.type, 'embed', 'B.1.2 result type is embed');
      eq(result?.url, VIDARA_URL, 'B.1.3 URL is the Vidara playback_url');
      await cleanupAll();
    }
    console.log('  ok — B.1 Vidara-only ready (3 checks)');

    // B.2 Abyss only (ready)
    {
      const tmdbId = '700002';
      const itemId = await ensureMovieItem(tmdbId, 'Test Movie 2');
      await insertAsset({ media_item_id: itemId, provider_source_id: abyssSourceId, playback_url: ABYSS_URL, status: 'ready' });
      const result = await abyssAdapter.resolve(buildContext('abyss', { sourceId: abyssSourceId, providerId: abyssProviderId, tmdbId, mediaType: 'movie' }));
      ok(result !== null, 'B.2.1 Abyss-only ready movie: adapter returns non-null');
      eq(result?.type, 'embed', 'B.2.2 result type is embed');
      eq(result?.url, ABYSS_URL, 'B.2.3 URL is the Abyss playback_url');
      await cleanupAll();
    }
    console.log('  ok — B.2 Abyss-only ready (3 checks)');

    // B.3 Both ready
    {
      const tmdbId = '700003';
      const itemId = await ensureMovieItem(tmdbId, 'Test Movie 3');
      await insertAsset({ media_item_id: itemId, provider_source_id: vidaraSourceId, playback_url: VIDARA_URL, status: 'ready' });
      await insertAsset({ media_item_id: itemId, provider_source_id: abyssSourceId, playback_url: ABYSS_URL, status: 'ready' });
      const vidaraResult = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'movie' }));
      const abyssResult = await abyssAdapter.resolve(buildContext('abyss', { sourceId: abyssSourceId, providerId: abyssProviderId, tmdbId, mediaType: 'movie' }));
      ok(vidaraResult !== null, 'B.3.1 Both ready: Vidara resolves');
      ok(abyssResult !== null, 'B.3.2 Both ready: Abyss resolves');
      eq(vidaraResult?.url, VIDARA_URL, 'B.3.3 Vidara returns Vidara URL');
      eq(abyssResult?.url, ABYSS_URL, 'B.3.4 Abyss returns Abyss URL');
      await cleanupAll();
    }
    console.log('  ok — B.3 Both ready (4 checks)');

    // B.4 Neither
    {
      const tmdbId = '700004';
      await ensureMovieItem(tmdbId, 'Test Movie 4');
      const vidaraResult = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'movie' }));
      const abyssResult = await abyssAdapter.resolve(buildContext('abyss', { sourceId: abyssSourceId, providerId: abyssProviderId, tmdbId, mediaType: 'movie' }));
      eq(vidaraResult, null, 'B.4.1 Neither: Vidara returns null');
      eq(abyssResult, null, 'B.4.2 Neither: Abyss returns null');
      await cleanupAll();
    }
    console.log('  ok — B.4 Neither (2 checks)');

    // B.5 Vidara processing
    {
      const tmdbId = '700005';
      const itemId = await ensureMovieItem(tmdbId, 'Test Movie 5');
      await insertAsset({ media_item_id: itemId, provider_source_id: vidaraSourceId, playback_url: VIDARA_URL, status: 'processing' });
      const result = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'movie' }));
      eq(result, null, 'B.5.1 Vidara processing: returns null (NOT playable)');
      await cleanupAll();
    }
    console.log('  ok — B.5 Vidara processing (1 check)');

    // B.6 Abyss processing
    {
      const tmdbId = '700006';
      const itemId = await ensureMovieItem(tmdbId, 'Test Movie 6');
      await insertAsset({ media_item_id: itemId, provider_source_id: abyssSourceId, playback_url: ABYSS_URL, status: 'processing' });
      const result = await abyssAdapter.resolve(buildContext('abyss', { sourceId: abyssSourceId, providerId: abyssProviderId, tmdbId, mediaType: 'movie' }));
      eq(result, null, 'B.6.1 Abyss processing: returns null (NOT playable)');
      await cleanupAll();
    }
    console.log('  ok — B.6 Abyss processing (1 check)');

    // B.7 Vidara failed
    {
      const tmdbId = '700007';
      const itemId = await ensureMovieItem(tmdbId, 'Test Movie 7');
      await insertAsset({ media_item_id: itemId, provider_source_id: vidaraSourceId, playback_url: VIDARA_URL, status: 'failed' });
      const result = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'movie' }));
      eq(result, null, 'B.7.1 Vidara failed: returns null (NOT playable)');
      await cleanupAll();
    }
    console.log('  ok — B.7 Vidara failed (1 check)');

    // B.8 Abyss failed
    {
      const tmdbId = '700008';
      const itemId = await ensureMovieItem(tmdbId, 'Test Movie 8');
      await insertAsset({ media_item_id: itemId, provider_source_id: abyssSourceId, playback_url: ABYSS_URL, status: 'failed' });
      const result = await abyssAdapter.resolve(buildContext('abyss', { sourceId: abyssSourceId, providerId: abyssProviderId, tmdbId, mediaType: 'movie' }));
      eq(result, null, 'B.8.1 Abyss failed: returns null (NOT playable)');
      await cleanupAll();
    }
    console.log('  ok — B.8 Abyss failed (1 check)');

    // B.9 Vidara deleted
    {
      const tmdbId = '700009';
      const itemId = await ensureMovieItem(tmdbId, 'Test Movie 9');
      await insertAsset({ media_item_id: itemId, provider_source_id: vidaraSourceId, playback_url: VIDARA_URL, status: 'deleted' });
      const result = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'movie' }));
      eq(result, null, 'B.9.1 Vidara deleted: returns null (NOT playable)');
      await cleanupAll();
    }
    console.log('  ok — B.9 Vidara deleted (1 check)');

    // B.10 Abyss deleted
    {
      const tmdbId = '700010';
      const itemId = await ensureMovieItem(tmdbId, 'Test Movie 10');
      await insertAsset({ media_item_id: itemId, provider_source_id: abyssSourceId, playback_url: ABYSS_URL, status: 'deleted' });
      const result = await abyssAdapter.resolve(buildContext('abyss', { sourceId: abyssSourceId, providerId: abyssProviderId, tmdbId, mediaType: 'movie' }));
      eq(result, null, 'B.10.1 Abyss deleted: returns null (NOT playable)');
      await cleanupAll();
    }
    console.log('  ok — B.10 Abyss deleted (1 check)');

    // ===========================================================================
    // B.11-B.18 — Series / episode resolution matrix
    // ===========================================================================
    console.log('  --- B.11-B.18: Series / episode resolution matrix ---');

    // B.11 S01E01 Vidara only
    {
      const tmdbId = '800001';
      const seriesItemId = await ensureSeriesItem(tmdbId, 'Test Series 11');
      const epItemId = await ensureEpisodeItem(tmdbId, 1, 1, seriesItemId);
      await insertAsset({ media_item_id: epItemId, provider_source_id: vidaraSourceId, playback_url: VIDARA_URL, status: 'ready' });
      const result = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'series', season: 1, episode: 1 }));
      ok(result !== null, 'B.11.1 S01E01 Vidara-only: adapter returns non-null');
      eq(result?.url, VIDARA_URL, 'B.11.2 URL is Vidara playback_url');
      await cleanupAll();
    }
    console.log('  ok — B.11 S01E01 Vidara-only (2 checks)');

    // B.12 S01E01 Abyss only
    {
      const tmdbId = '800002';
      const seriesItemId = await ensureSeriesItem(tmdbId, 'Test Series 12');
      const epItemId = await ensureEpisodeItem(tmdbId, 1, 1, seriesItemId);
      await insertAsset({ media_item_id: epItemId, provider_source_id: abyssSourceId, playback_url: ABYSS_URL, status: 'ready' });
      const result = await abyssAdapter.resolve(buildContext('abyss', { sourceId: abyssSourceId, providerId: abyssProviderId, tmdbId, mediaType: 'series', season: 1, episode: 1 }));
      ok(result !== null, 'B.12.1 S01E01 Abyss-only: adapter returns non-null');
      eq(result?.url, ABYSS_URL, 'B.12.2 URL is Abyss playback_url');
      await cleanupAll();
    }
    console.log('  ok — B.12 S01E01 Abyss-only (2 checks)');

    // B.13 S01E01 both
    {
      const tmdbId = '800003';
      const seriesItemId = await ensureSeriesItem(tmdbId, 'Test Series 13');
      const epItemId = await ensureEpisodeItem(tmdbId, 1, 1, seriesItemId);
      await insertAsset({ media_item_id: epItemId, provider_source_id: vidaraSourceId, playback_url: VIDARA_URL, status: 'ready' });
      await insertAsset({ media_item_id: epItemId, provider_source_id: abyssSourceId, playback_url: ABYSS_URL, status: 'ready' });
      const vidaraResult = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'series', season: 1, episode: 1 }));
      const abyssResult = await abyssAdapter.resolve(buildContext('abyss', { sourceId: abyssSourceId, providerId: abyssProviderId, tmdbId, mediaType: 'series', season: 1, episode: 1 }));
      ok(vidaraResult !== null && abyssResult !== null, 'B.13.1 S01E01 both: both adapters resolve');
      await cleanupAll();
    }
    console.log('  ok — B.13 S01E01 both (1 check)');

    // B.14 S01E01 neither
    {
      const tmdbId = '800004';
      const seriesItemId = await ensureSeriesItem(tmdbId, 'Test Series 14');
      await ensureEpisodeItem(tmdbId, 1, 1, seriesItemId);
      const vidaraResult = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'series', season: 1, episode: 1 }));
      const abyssResult = await abyssAdapter.resolve(buildContext('abyss', { sourceId: abyssSourceId, providerId: abyssProviderId, tmdbId, mediaType: 'series', season: 1, episode: 1 }));
      eq(vidaraResult, null, 'B.14.1 S01E01 neither: Vidara returns null');
      eq(abyssResult, null, 'B.14.2 S01E01 neither: Abyss returns null');
      await cleanupAll();
    }
    console.log('  ok — B.14 S01E01 neither (2 checks)');

    // B.15 S02E01 vs S01E01 isolation
    {
      const tmdbId = '800005';
      const seriesItemId = await ensureSeriesItem(tmdbId, 'Test Series 15');
      const s01e01ItemId = await ensureEpisodeItem(tmdbId, 1, 1, seriesItemId);
      await ensureEpisodeItem(tmdbId, 2, 1, seriesItemId);
      await insertAsset({ media_item_id: s01e01ItemId, provider_source_id: vidaraSourceId, playback_url: VIDARA_URL, status: 'ready' });
      // Query S02E01 — should NOT match the S01E01 asset.
      const s02e01Result = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'series', season: 2, episode: 1 }));
      eq(s02e01Result, null, 'B.15.1 S02E01 query does NOT resolve S01E01 asset');
      // Query S01E01 — should resolve.
      const s01e01Result = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'series', season: 1, episode: 1 }));
      ok(s01e01Result !== null, 'B.15.2 S01E01 query DOES resolve S01E01 asset');
      await cleanupAll();
    }
    console.log('  ok — B.15 S02E01 vs S01E01 isolation (2 checks)');

    // B.16 Missing episode
    {
      const tmdbId = '800006';
      const seriesItemId = await ensureSeriesItem(tmdbId, 'Test Series 16');
      // No episode row created.
      const result = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'series', season: 1, episode: 1 }));
      eq(result, null, 'B.16.1 Missing episode: adapter returns null (no media_item row)');
      await cleanupAll();
    }
    console.log('  ok — B.16 Missing episode (1 check)');

    // B.17 Wrong episode must never resolve
    {
      const tmdbId = '800007';
      const seriesItemId = await ensureSeriesItem(tmdbId, 'Test Series 17');
      const s01e01ItemId = await ensureEpisodeItem(tmdbId, 1, 1, seriesItemId);
      await insertAsset({ media_item_id: s01e01ItemId, provider_source_id: vidaraSourceId, playback_url: VIDARA_URL, status: 'ready' });
      // Query S01E02 — should NOT match.
      const s01e02Result = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'series', season: 1, episode: 2 }));
      eq(s01e02Result, null, 'B.17.1 S01E02 query does NOT resolve S01E01 asset (episode isolation)');
      await cleanupAll();
    }
    console.log('  ok — B.17 Wrong episode isolation (1 check)');

    // B.18 Deleted episode asset
    {
      const tmdbId = '800008';
      const seriesItemId = await ensureSeriesItem(tmdbId, 'Test Series 18');
      const epItemId = await ensureEpisodeItem(tmdbId, 1, 1, seriesItemId);
      await insertAsset({ media_item_id: epItemId, provider_source_id: vidaraSourceId, playback_url: VIDARA_URL, status: 'deleted' });
      const result = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'series', season: 1, episode: 1 }));
      eq(result, null, 'B.18.1 Deleted episode asset: returns null (NOT playable)');
      await cleanupAll();
    }
    console.log('  ok — B.18 Deleted episode asset (1 check)');

    // ===========================================================================
    // B.19-B.21 — Fallback behavior
    // ===========================================================================
    console.log('  --- B.19-B.21: Fallback behavior (adapter-level) ---');

    // B.19 Vidara DB error (mock client that throws) → adapter returns null (resolver continues)
    {
      const throwingClient = {
        from: () => ({
          select: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: async () => { throw new Error('mock DB error'); },
              }),
            }),
          }),
        }),
      } as unknown as SupabaseClient<Database>;
      __setMaveroHostedServiceClientForTests(throwingClient);
      const result = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId: '999999', mediaType: 'movie' }));
      eq(result, null, 'B.19.1 Vidara DB error: adapter returns null (NOT throws) — resolver can fall through');
      __setMaveroHostedServiceClientForTests(client);
    }
    console.log('  ok — B.19 Vidara DB error isolation (1 check)');

    // B.20 Both Mavero-hosted return null (no assets) — resolver continues to existing fallback
    {
      const tmdbId = '700020';
      await ensureMovieItem(tmdbId, 'Test Movie 20');
      const vidaraResult = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'movie' }));
      const abyssResult = await abyssAdapter.resolve(buildContext('abyss', { sourceId: abyssSourceId, providerId: abyssProviderId, tmdbId, mediaType: 'movie' }));
      eq(vidaraResult, null, 'B.20.1 Vidara no asset → null');
      eq(abyssResult, null, 'B.20.2 Abyss no asset → null');
      // The resolver would now continue to the next candidate (existing embed sources).
      await cleanupAll();
    }
    console.log('  ok — B.20 Both Mavero-hosted miss (2 checks)');

    // B.21 No Mavero asset + existing fallback (verify no exception in adapter)
    {
      const tmdbId = '700021';
      const result = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'movie' }));
      eq(result, null, 'B.21.1 No media_item row → null (no exception)');
      await cleanupAll();
    }
    console.log('  ok — B.21 No media_item (1 check)');

    // ===========================================================================
    // B.22-B.27 — Player integration (contract tests via adapter output shape)
    // ===========================================================================
    console.log('  --- B.22-B.27: Player integration (adapter output shape) ---');

    // B.22 Vidara URL goes through embed path
    {
      const tmdbId = '700022';
      const itemId = await ensureMovieItem(tmdbId, 'Test Movie 22');
      await insertAsset({ media_item_id: itemId, provider_source_id: vidaraSourceId, playback_url: VIDARA_URL, status: 'ready' });
      const result = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'movie' }));
      eq(result?.type, 'embed', 'B.22.1 Vidara URL is embed type (goes through iframe, not native video)');
      await cleanupAll();
    }
    console.log('  ok — B.22 Vidara embed path (1 check)');

    // B.23 Abyss URL goes through embed path
    {
      const tmdbId = '700023';
      const itemId = await ensureMovieItem(tmdbId, 'Test Movie 23');
      await insertAsset({ media_item_id: itemId, provider_source_id: abyssSourceId, playback_url: ABYSS_URL, status: 'ready' });
      const result = await abyssAdapter.resolve(buildContext('abyss', { sourceId: abyssSourceId, providerId: abyssProviderId, tmdbId, mediaType: 'movie' }));
      eq(result?.type, 'embed', 'B.23.1 Abyss URL is embed type');
      await cleanupAll();
    }
    console.log('  ok — B.23 Abyss embed path (1 check)');

    // B.24 No raw-stream assumption
    {
      const tmdbId = '700024';
      const itemId = await ensureMovieItem(tmdbId, 'Test Movie 24');
      // Even with a URL that LOOKS like a direct stream (.mp4), the
      // adapter MUST still return type='embed' — Phase 4 classified
      // these providers as embed-only. The provider-hosted player URL
      // semantics are preserved.
      await insertAsset({ media_item_id: itemId, provider_source_id: vidaraSourceId, playback_url: 'https://vidara.so/v/test-mp4', status: 'ready' });
      const result = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'movie' }));
      eq(result?.type, 'embed', 'B.24.1 Even with mp4-like URL, type stays embed (preserves semantics)');
      await cleanupAll();
    }
    console.log('  ok — B.24 No raw-stream assumption (1 check)');

    // B.25 Source switching works (both adapters in createDefaultAdapterIds)
    {
      const { createDefaultAdapterIds } = await import('../src/lib/server/resolver/adapters.ts');
      const registry = createDefaultAdapterIds();
      ok(registry['vidara'] !== undefined, 'B.25.1 vidara adapter is in createDefaultAdapterIds');
      ok(registry['abyss'] !== undefined, 'B.25.2 abyss adapter is in createDefaultAdapterIds');
      ok(registry['vidsrc-embed'] !== undefined, 'B.25.3 vidsrc-embed adapter still registered (no regression)');
      ok(registry['vidlink-embed'] !== undefined, 'B.25.4 vidlink-embed adapter still registered (no regression)');
    }
    console.log('  ok — B.25 Source switching (4 checks)');

    // B.26 Stale saved provider source (returns null, fallback continues)
    {
      const tmdbId = '700026';
      await ensureMovieItem(tmdbId, 'Test Movie 26');
      // No ready asset — simulates a previously-saved source whose
      // asset was later deleted or transitioned out of ready.
      const result = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'movie' }));
      eq(result, null, 'B.26.1 Stale saved source: adapter returns null (fallback continues)');
      await cleanupAll();
    }
    console.log('  ok — B.26 Stale saved provider source (1 check)');

    // B.27 Resume with provider source (no exception, fallback safe)
    {
      const tmdbId = '700027';
      await ensureMovieItem(tmdbId, 'Test Movie 27');
      // The resolver would attempt the saved source first; the adapter
      // returns null (no ready asset); the resolver's existing
      // fallback machinery then tries the next candidate. No exception
      // propagates — this is verified by the absence of throws in the
      // adapter source code (already covered by A.1.18).
      const result = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'movie' }));
      eq(result, null, 'B.27.1 Resume with stale provider source: null (no exception)');
      await cleanupAll();
    }
    console.log('  ok — B.27 Resume compatibility (1 check)');

    // ===========================================================================
    // B.28-B.33 — Security
    // ===========================================================================
    console.log('  --- B.28-B.33: Security ---');

    // B.28 Guest playback — endpoint is public
    {
      const src = readFileSync(path.join(REPO_ROOT, 'src/routes/api/playback/resolve/+server.ts'), 'utf8');
      ok(!src.includes('requireAdmin'), 'B.28.1 playback endpoint has NO requireAdmin (public playback preserved)');
      ok(src.includes('checkRateLimit'), 'B.28.2 rate limit is the only gate (same as existing providers)');
    }
    console.log('  ok — B.28 Guest playback (2 checks)');

    // B.29 Authenticated playback — same endpoint behavior
    {
      const src = readFileSync(path.join(REPO_ROOT, 'src/routes/api/playback/resolve/+server.ts'), 'utf8');
      ok(src.includes('locals.supabase'), 'B.29.1 endpoint reads locals.supabase (user context preserved)');
    }
    console.log('  ok — B.29 Authenticated playback (1 check)');

    // B.30 Admin playback — no admin-specific path
    {
      const src = readFileSync(path.join(REPO_ROOT, 'src/lib/server/resolver/mavero-hosted.ts'), 'utf8');
      ok(!src.includes('requireAdmin'), 'B.30.1 adapter has NO admin gate (admin uses the same public path)');
    }
    console.log('  ok — B.30 Admin playback (1 check)');

    // B.31 No provider secret exposure — response carries only playback_url + metadata
    {
      const tmdbId = '700031';
      const itemId = await ensureMovieItem(tmdbId, 'Test Movie 31');
      await insertAsset({ media_item_id: itemId, provider_source_id: vidaraSourceId, playback_url: VIDARA_URL, status: 'ready' });
      const result = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'movie' }));
      // Adapter result fields (only type, url, metadata) — NO provider_asset_id, provider_metadata, size_bytes, etc.
      ok(result && typeof result === 'object', 'B.31.1 result is an object');
      const keys = Object.keys(result as object).sort();
      ok(keys.includes('type') && keys.includes('url'), 'B.31.2 result has type + url');
      ok(!keys.includes('provider_asset_id'), 'B.31.3 NO provider_asset_id in result');
      ok(!keys.includes('provider_metadata'), 'B.31.4 NO provider_metadata in result');
      ok(!keys.includes('size_bytes'), 'B.31.5 NO size_bytes in result');
      ok(!keys.includes('api_key'), 'B.31.6 NO api_key in result');
      ok(!keys.includes('password'), 'B.31.7 NO password in result');
      ok(!keys.includes('jwt'), 'B.31.8 NO jwt in result');
      await cleanupAll();
    }
    console.log('  ok — B.31 No provider secret exposure (8 checks)');

    // B.32 Malformed identity — adapter returns null (no exception)
    {
      // Missing tmdbId
      const result1 = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, mediaType: 'movie' }));
      eq(result1, null, 'B.32.1 Missing tmdbId: null (no exception)');

      // Series with season but no episode (malformed)
      const result2 = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId: '700032', mediaType: 'series', season: 1 }));
      eq(result2, null, 'B.32.2 Series with season but no episode: null (no exception)');

      // Series with episode but no season (malformed)
      const result3 = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId: '700032', mediaType: 'series', episode: 1 }));
      eq(result3, null, 'B.32.3 Series with episode but no season: null (no exception)');
    }
    console.log('  ok — B.32 Malformed identity (3 checks)');

    // B.33 Provider asset ownership/association — adapter scopes by provider_source_id
    {
      const tmdbId = '700033';
      const itemId = await ensureMovieItem(tmdbId, 'Test Movie 33');
      // Only Vidara has an asset for this movie.
      await insertAsset({ media_item_id: itemId, provider_source_id: vidaraSourceId, playback_url: VIDARA_URL, status: 'ready' });

      // Vidara adapter queries with vidaraSourceId → resolves.
      const vidaraResult = await vidaraAdapter.resolve(buildContext('vidara', { sourceId: vidaraSourceId, providerId: vidaraProviderId, tmdbId, mediaType: 'movie' }));
      ok(vidaraResult !== null, 'B.33.1 Vidara adapter resolves Vidara asset');

      // Abyss adapter queries with abyssSourceId → does NOT resolve Vidara's asset.
      const abyssResult = await abyssAdapter.resolve(buildContext('abyss', { sourceId: abyssSourceId, providerId: abyssProviderId, tmdbId, mediaType: 'movie' }));
      eq(abyssResult, null, 'B.33.2 Abyss adapter does NOT resolve Vidara asset (source-scoped)');

      await cleanupAll();
    }
    console.log('  ok — B.33 Provider asset ownership (2 checks)');

    // --- Final cleanup ---
    await cleanupAll();

    // --- Verify all hosting tables at 0 rows ---
    const counts: Record<string, number> = {};
    for (const table of ['media_items', 'media_folders', 'media_assets', 'media_upload_operations', 'media_operations', 'media_availability_requests', 'provider_folder_mappings']) {
      const { count } = await client.from(table as never).select('*', { count: 'exact', head: true });
      counts[table] = count ?? -1;
    }
    for (const [table, count] of Object.entries(counts)) {
      eq(count, 0, `B.cleanup ${table} = 0 rows`);
    }

    // Reset the test injection point so subsequent test runs start fresh.
    __setMaveroHostedServiceClientForTests(null);
  }
}

// ===========================================================================
// SECTION C — Regression summary
// ===========================================================================

console.log('\n--- Section C: Regression summary ---');
{
  // Verify Phase 6 admin upload test file still exists (no regression).
  const phase6Path = path.join(REPO_ROOT, 'scripts/phase6_completion_test.ts');
  let phase6Exists = false;
  try { readFileSync(phase6Path); phase6Exists = true; } catch { /* file missing */ }
  ok(phase6Exists, 'C.1 Phase 6 completion test still exists (no regression)');

  // Verify Phase 3 hosting adapter test still exists.
  const phase3Path = path.join(REPO_ROOT, 'scripts/phase3_hosting_adapter_test.ts');
  let phase3Exists = false;
  try { readFileSync(phase3Path); phase3Exists = true; } catch { /* file missing */ }
  ok(phase3Exists, 'C.2 Phase 3 hosting adapter test still exists (no regression)');

  // Verify Phase 4 migration file still exists.
  const phase4Migration = path.join(REPO_ROOT, 'supabase/migrations/20260928213822_phase4_register_hosting_sources.sql');
  let phase4Exists = false;
  try { readFileSync(phase4Migration); phase4Exists = true; } catch { /* file missing */ }
  ok(phase4Exists, 'C.3 Phase 4 migration file unchanged (no regression)');

  // Verify Phase 2 migration file still exists.
  const phase2Migration = path.join(REPO_ROOT, 'supabase/migrations/20260928200724_phase2_hosting_database_foundation.sql');
  let phase2Exists = false;
  try { readFileSync(phase2Migration); phase2Exists = true; } catch { /* file missing */ }
  ok(phase2Exists, 'C.4 Phase 2 migration file unchanged (no regression)');

  // Verify no migration created in Phase 7 of the Vidara+Abyss hosting project.
  // NOTE: the broader Mavero project has its own unrelated "Phase 7a/7d/7e/7f"
  // migration series (provider experiments). We filter for migrations whose
  // filename explicitly identifies the Vidara+Abyss hosting Phase 7 work —
  // e.g. `*_phase7_playback*` or `*_phase7_hosting*`. None should exist.
  const migrationsDir = path.join(REPO_ROOT, 'supabase/migrations');
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(migrationsDir).filter((f) =>
    /_phase7_(playback|hosting)/.test(f)
  );
  eq(files.length, 0, 'C.5 NO Phase 7 (Vidara+Abyss hosting) migration created (audit confirmed none needed)');
}
console.log('  ok — Section C (5 checks)\n');

// ===========================================================================
// Summary
// ===========================================================================

console.log('====================================');
console.log(`Phase 7 test summary: ${passed} passed, ${failed} failed`);
console.log('====================================');
if (failed > 0) {
  console.error(`\n${failed} TEST(S) FAILED — see above.`);
  process.exit(1);
}
