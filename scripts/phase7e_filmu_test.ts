import assert from 'node:assert/strict';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { ResolverError } from '$lib/server/resolver/errors';
import { createDefaultAdapters, createDefaultAdapterIds } from '$lib/server/resolver/adapters';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { TrustedResolutionConfig } from '$lib/server/resolver/types';

// Phase 7E FilmU embed provider tests.
//
// FilmU (embed.filmu.in) is an embed provider that uses TMDB numeric IDs.
// The public player SPA (served from https://embed.filmu.in/) exposes these
// React-Router routes (verified by reading the public JS bundle):
//   Movie: https://embed.filmu.in/embed/movie/{tmdb_id}
//   TV:    https://embed.filmu.in/embed/tv/{tmdb_id}/{season}/{episode}
//
// Live browser verification (2026-09-05) confirms:
//   - TMDB 550        → "Fight Club — FilmU Player"     (movie loads, fetches
//                       image.tmdb.org/t/p/w1280/c6OLXfKAk5BKeR6broC8pYiCquX.jpg
//                       which is the TMDB backdrop for TMDB id 550)
//   - TMDB 1399/1/1   → "Game of Thrones — FilmU Player"
//   - TMDB 1399/8/6   → "Game of Thrones — FilmU Player" (multi-digit ok)
//   - IMDb tt0137523  → SPA falls back to homepage (IMDb NOT accepted)
//   - IMDb tt0944947  → SPA falls back to homepage (IMDb NOT accepted)
//   - No API key required (homepage meta description: "No API key required.")
//
// Sandbox compatibility: FilmU ships a sandbox-blocker that rejects iframes
// whose `sandbox` attribute lacks `allow-same-origin`. Mavero's existing
// `iframeSandboxAttribute('required')` returns
// "allow-forms allow-presentation allow-same-origin allow-scripts" — which
// includes `allow-same-origin`, so the player loads without any sandbox
// weakening.
//
// This source uses the existing generic template adapter with
// identifier_mode='tmdb_id'. These tests verify:
//   - Provider registration shape (generic template adapter, no custom adapter).
//   - Movie URL follows the documented pattern with the TMDB numeric ID.
//   - TV URL follows the documented pattern with TMDB ID + season + episode.
//   - Multi-digit season/episode are passed through verbatim (no zero-pad).
//   - Season and episode are included for TV, omitted for movie.
//   - Missing TMDB ID → MISSING_IDENTIFIER (graceful no-candidate).
//   - IMDb ID is NOT substituted for the TMDB ID.
//   - Missing season/episode for TV → graceful no-candidate.
//   - The result is an embed candidate, never a direct media source.
//   - Anime is rejected (capability.anime = false).
//   - Exact origin enforcement (tampered template rejected).
//   - Lifecycle/experimental gates.
//   - No proxy/scraper/direct-media extraction layer exists.
//   - No apikey query parameter is appended.

const providerId = '00000000-0000-4000-8000-0000000000f1';
const sourceId = '00000000-0000-4000-8000-0000000000f2';
const iframeOrigin = 'https://embed.filmu.in';

const capabilities = {
  movie: true,
  series: true,
  anime: false,
  result_type: 'embed',
  supports_episode: true,
  supports_direct: false,
  supports_server_selection: false,
  automatic_server_fallback: false,
  supports_subtitles: false,
  supports_language_selection: false,
  supports_download: false,
  allow_experimental_playback: true,
  sandbox_policy: 'required',
  allowed_embed_origins: [iframeOrigin],
};

const provider = {
  id: providerId,
  name: 'FilmU',
  status: 'experimental',
  enabled: true,
  integration_type: 'template' as const,
  adapter_id: null,
  capabilities,
};

const source = {
  id: sourceId,
  provider_id: providerId,
  name: 'FilmU Embed',
  status: 'experimental',
  enabled: true,
  visibility: 'public' as const,
  integration_type: 'template' as const,
  capabilities,
  movie_template: `${iframeOrigin}/embed/movie/{tmdb_id}`,
  series_template: `${iframeOrigin}/embed/tv/{tmdb_id}/{season}/{episode}`,
  anime_template: null,
  identifier_mode: 'tmdb_id' as const,
  audio_languages: ['multi'],
  subtitle_capability: false,
  quality_capability: [] as string[],
};

const config: TrustedResolutionConfig = { provider, source };
const genericAdapters = createDefaultAdapters();

function content(type: 'movie' | 'series' | 'anime', tmdb?: string, imdb?: string): NormalizedMediaItem {
  return {
    id: type === 'movie' ? '550' : type === 'series' ? '1399' : 'anime-fixture',
    title: 'Fixture title',
    year: 2024,
    type,
    runtime: '120 min',
    rating: 8,
    genres: ['Drama'],
    description: 'Fixture',
    poster: 'https://image.example.test/poster.jpg',
    backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#b1a1ff',
    source: { provider: 'tmdb', externalId: tmdb, fetchedAt: new Date().toISOString() },
    externalIds: { tmdb, imdb },
  };
}

// === Test 1: Provider exists on the generic template adapter (no custom adapter code) ===
assert.equal(genericAdapters.template.integrationType, 'template');
assert.equal(genericAdapters.template.adapterId, undefined);
const customAdapterIds = Object.keys(createDefaultAdapterIds());
assert.equal(customAdapterIds.includes('filmu-embed'), false, 'FilmU must not register a custom adapter');
assert.equal(customAdapterIds.includes('filmu'), false, 'FilmU must not register a custom adapter');

// === Test 2: Movie with TMDB numeric ID generates the exact documented URL ===
// Live-verified: https://embed.filmu.in/embed/movie/550 → "Fight Club — FilmU Player"
const movie = await resolveSourceFromConfig(
  { sourceId, contentId: '550', mediaType: 'movie' },
  config,
  content('movie', '550', 'tt0137523'),
  { adapters: genericAdapters },
);
assert.equal(movie.type, 'embed', 'FilmU must be an embed candidate, not direct media');
assert.equal(movie.url, 'https://embed.filmu.in/embed/movie/550');
assert.equal(movie.providerId, providerId);
assert.equal(movie.sourceId, sourceId);
assert.equal(movie.mediaType, 'movie');
assert.equal(movie.sandboxPolicy, 'required');
assert.equal(movie.protocol, undefined, 'embed candidates must not carry a direct playback protocol');
assert.equal(movie.metadata?.providerName, 'FilmU');
assert.equal(movie.metadata?.sourceName, 'FilmU Embed');

// === Test 3: Live-verified movie example (TMDB 550 = Fight Club) ===
// Live test: page title becomes "Fight Club — FilmU Player" and the player
// fetches image.tmdb.org/t/p/w1280/c6OLXfKAk5BKeR6broC8pYiCquX.jpg (the TMDB
// backdrop for TMDB id 550). The path must NOT contain an IMDb ID.
assert.equal(movie.url, 'https://embed.filmu.in/embed/movie/550');
assert.equal(new URL(movie.url).pathname.includes('tt'), false, 'movie URL path must use the TMDB numeric ID, not an IMDb ID');
assert.equal(movie.url.includes('apikey'), false, 'no apikey query parameter may be appended');

// === Test 4: TV with TMDB ID + season + episode follows the documented pattern ===
// Live-verified: https://embed.filmu.in/embed/tv/1399/1/1 → "Game of Thrones — FilmU Player"
const episode = await resolveSourceFromConfig(
  { sourceId, contentId: '1399', mediaType: 'series', season: 1, episode: 1 },
  config,
  content('series', '1399', 'tt0944947'),
  { adapters: genericAdapters },
);
assert.equal(episode.type, 'embed');
assert.equal(episode.url, 'https://embed.filmu.in/embed/tv/1399/1/1');
assert.equal(episode.mediaType, 'series');

// === Test 5: Multi-digit season/episode are included verbatim (no zero-padding) ===
// Live-verified: https://embed.filmu.in/embed/tv/1399/8/6 → "Game of Thrones — FilmU Player"
const episodeMulti = await resolveSourceFromConfig(
  { sourceId, contentId: '1399', mediaType: 'series', season: 8, episode: 6 },
  config,
  content('series', '1399', 'tt0944947'),
  { adapters: genericAdapters },
);
assert.equal(episodeMulti.url, 'https://embed.filmu.in/embed/tv/1399/8/6');
assert.equal(episodeMulti.url.includes('season='), false, 'no season= query parameter may be constructed');
assert.equal(episodeMulti.url.includes('episode='), false, 'no episode= query parameter may be constructed');
assert.equal(episodeMulti.url.includes('/08/'), false, 'no zero-padded season may be constructed');
assert.equal(episodeMulti.url.includes('/06/'), false, 'no zero-padded episode may be constructed');

// === Test 6: TMDB numeric ID is required — missing TMDB → MISSING_IDENTIFIER ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '550', mediaType: 'movie' },
    config,
    content('movie', undefined, 'tt0137523'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
  'Missing TMDB ID must throw MISSING_IDENTIFIER (graceful no-candidate), not guess an ID',
);

// === Test 7: IMDb ID is NOT substituted for the TMDB ID ===
// Live-verified: https://embed.filmu.in/embed/movie/tt0137523 and
// /embed/tv/tt0944947/1/1 both fall back to the SPA homepage — IMDb is not
// accepted. The resolver must therefore fail with MISSING_IDENTIFIER when
// only the IMDb ID is present, rather than build a non-working URL.
const imdbOnlyFailure = await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '1399', mediaType: 'series', season: 1, episode: 1 },
    config,
    content('series', undefined, 'tt0944947'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
);
assert.equal(imdbOnlyFailure, undefined);

// === Test 8: Missing season/episode for TV → graceful no-candidate ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '1399', mediaType: 'series', season: 1 },
    config,
    content('series', '1399', 'tt0944947'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && (error.code === 'MISSING_IDENTIFIER' || error.code === 'INVALID_REQUEST'),
  'Season without episode must not produce a TV URL',
);

await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '1399', mediaType: 'series' },
    config,
    content('series', '1399', 'tt0944947'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && (error.code === 'MISSING_IDENTIFIER' || error.code === 'INVALID_REQUEST'),
  'TV without season and episode must not produce a URL',
);

// === Test 9: Anime rejected (capability.anime = false) ===
// Although the public FilmU bundle exposes /embed/anime/:id/* routes, the
// anime ID semantics are not publicly documented, so anime is disabled until
// verified. The resolver must reject anime with UNSUPPORTED_MEDIA_TYPE.
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 1 },
    config,
    content('anime', '16459', 'tt0000000'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'UNSUPPORTED_MEDIA_TYPE',
);

// === Test 10: Tampered movie template (wrong origin) → INVALID_SOURCE_URL ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '550', mediaType: 'movie' },
    { ...config, source: { ...source, movie_template: 'https://evil.example.test/embed/movie/{tmdb_id}' } },
    content('movie', '550', 'tt0137523'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_SOURCE_URL',
);

// === Test 11: Tampered TV template (wrong origin) → INVALID_SOURCE_URL ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '1399', mediaType: 'series', season: 1, episode: 1 },
    { ...config, source: { ...source, series_template: 'https://evil.example.test/embed/tv/{tmdb_id}/{season}/{episode}' } },
    content('series', '1399', 'tt0944947'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_SOURCE_URL',
);

// === Test 12: Disabled provider → PROVIDER_DISABLED ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '550', mediaType: 'movie' },
    { ...config, provider: { ...provider, enabled: false } },
    content('movie', '550', 'tt0137523'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_DISABLED',
);

// === Test 13: Disabled source → SOURCE_DISABLED ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '550', mediaType: 'movie' },
    { ...config, source: { ...source, enabled: false } },
    content('movie', '550', 'tt0137523'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'SOURCE_DISABLED',
);

// === Test 14: Experimental playback gate ===
await assert.rejects(
  () => resolveSourceFromConfig(
    { sourceId, contentId: '550', mediaType: 'movie' },
    {
      provider: { ...provider, capabilities: { ...capabilities, allow_experimental_playback: false } },
      source: { ...source, capabilities: { ...capabilities, allow_experimental_playback: false } },
    },
    content('movie', '550', 'tt0137523'),
    { adapters: genericAdapters },
  ),
  (error: unknown) => error instanceof ResolverError && error.code === 'PROVIDER_DISABLED',
);

// === Test 15: Experimental source with allow_experimental_playback=true resolves ===
const experimentalOk = await resolveSourceFromConfig(
  { sourceId, contentId: '550', mediaType: 'movie' },
  { provider: { ...provider, status: 'experimental', enabled: true }, source: { ...source, status: 'experimental', enabled: true } },
  content('movie', '550', 'tt0137523'),
  { adapters: genericAdapters },
);
assert.equal(experimentalOk.type, 'embed');
assert.equal(experimentalOk.url, 'https://embed.filmu.in/embed/movie/550');

// === Test 16: Embed-only — HTTPS origin, no direct-media/extraction artifacts ===
assert.equal(movie.url.startsWith('https://embed.filmu.in/'), true, 'URL must stay on the documented HTTPS origin');
assert.equal(movie.url.includes('.m3u8'), false, 'no HLS direct media URL may be produced');
assert.equal(movie.url.includes('.mp4'), false, 'no MP4 direct media URL may be produced');
assert.equal(movie.url.includes('.mpd'), false, 'no DASH direct media URL may be produced');
assert.equal(episode.url.startsWith('https://embed.filmu.in/'), true, 'TV URL must stay on the documented HTTPS origin');
assert.equal(movie.metadata?.providerName, 'FilmU', 'provider display name must be FilmU');

// === Test 17: No apikey query parameter is appended (FilmU documents none is required) ===
assert.equal(movie.url.includes('apikey'), false, 'no apikey query parameter may be appended');
assert.equal(episode.url.includes('apikey'), false, 'no apikey query parameter may be appended');
assert.equal(movie.url.includes('?'), false, 'movie URL must be path-only (no query string)');
assert.equal(episode.url.includes('?'), false, 'TV URL must be path-only (no query string)');

// === Test 18: TMDB ID is preserved as a bare numeric path segment (no tt prefix) ===
assert.equal(movie.url.includes('tt0137523'), false, 'IMDb ID must never appear in the URL path');
assert.equal(episode.url.includes('tt0944947'), false, 'IMDb ID must never appear in the TV URL path');
assert.equal(movie.url.endsWith('/550'), true, 'movie URL must end with the bare TMDB numeric ID');
assert.equal(episode.url.endsWith('/1/1'), true, 'TV URL must end with /season/episode');

console.log('Phase 7E FilmU embed tests passed: generic template adapter (no custom adapter), exact documented movie URL with TMDB numeric ID (live-verified 550 → Fight Club), exact documented TV URL with TMDB ID + season + episode (live-verified 1399/1/1 → Game of Thrones, 1399/8/6 → Game of Thrones), multi-digit season/episode pass through verbatim with no zero-padding, missing-TMDB graceful MISSING_IDENTIFIER, IMDb-not-substituted-for-TMDB (live-confirmed IMDb IDs fall back to the SPA homepage), missing season/episode graceful failure, anime rejection (anime ID semantics undocumented), tampered-template rejection for both movie and TV, disabled provider/source gates, experimental playback gate, embed-only result (no direct media URLs), HTTPS origin enforcement, no apikey query parameter, bare TMDB numeric path segment with no tt prefix.');
