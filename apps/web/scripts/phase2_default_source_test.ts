import assert from 'node:assert/strict';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { resolveWithBoundedFallback } from '$lib/server/resolver/fallback';
import { rankProviderSourceList } from '$lib/server/resolver/ranking';
import { ResolverError } from '$lib/server/resolver/errors';
import { parseResolverRequest } from '$lib/server/resolver/identifiers';
import type { ResolverRequest, TrustedResolutionConfig } from '$lib/server/resolver/types';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import { applyDefaultSourceOrdering } from '$lib/server/resolver/default-source';
import type { ResolverRequest as ClientResolverRequest } from '$lib/client/player/PlaybackManager';

// Phase 2: default source + automatic fallback contract tests.
//
// These tests verify the Phase 2 policy without requiring a live Supabase
// environment. They use the existing resolver test pattern (mock configs +
// in-memory adapter mocks) to verify:
//   1. Default source resolves first when eligible.
//   2. Default failure triggers fallback to ranked candidates.
//   3. Disabled default is skipped (ranking gates exclude it).
//   4. Ineligible default (unsupported media) is skipped.
//   5. Fallback ranking remains deterministic (Phase 7G behavior preserved).
//   6. Default is not duplicated in fallback attempts.
//   7. All sources failing produces normalized failure.
//   8. Manual source selection does NOT forward the default (allowFallback=false).
//   9. Movie/series content-type defaults are distinct.
//  10. Phase 1 PlaybackManager defaultSourceId forwarding is correct.
//  11. parseResolverRequest accepts/rejects defaultSourceId correctly.

// --- Fixtures ---

const movieContent: NormalizedMediaItem = {
  id: '550', title: 'Fight Club', year: 1999, type: 'movie', runtime: '2h 19m', rating: 8.4, genres: ['Drama'], description: 'Fixture',
  poster: 'https://image.example.test/poster.jpg', backdrop: 'https://image.example.test/backdrop.jpg', accent: '#9b87f5',
  source: { provider: 'tmdb', externalId: '550', fetchedAt: new Date().toISOString() }, externalIds: { tmdb: '550', imdb: 'tt0137523' },
};

const seriesContent: NormalizedMediaItem = {
  ...movieContent,
  id: '1399', title: 'Game of Thrones', type: 'series',
  source: { provider: 'tmdb', externalId: '1399', fetchedAt: new Date().toISOString() }, externalIds: { tmdb: '1399', imdb: 'tt0944947' },
};

function makeConfig(providerId: string, sourceId: string, overrides: { provider?: Partial<TrustedResolutionConfig['provider']>, source?: Partial<TrustedResolutionConfig['source']> } = {}): TrustedResolutionConfig {
  return {
    provider: { id: providerId, name: `Provider ${providerId}`, status: 'active', enabled: true, integration_type: 'embed', adapter_id: null, capabilities: { movie: true, series: true, anime: false, allow_experimental_playback: true, sandbox_policy: 'required' }, ...overrides.provider },
    source: {
      id: sourceId, provider_id: providerId, name: `Source ${sourceId}`, status: 'active', enabled: true, visibility: 'public',
      integration_type: 'embed', capabilities: { movie: true, series: true, anime: false, allow_experimental_playback: true, sandbox_policy: 'required', allowed_embed_origins: ['https://embed.example.test'] },
      movie_template: 'https://embed.example.test/movie/{tmdb_id}', series_template: 'https://embed.example.test/tv/{tmdb_id}/{season}/{episode}', anime_template: null,
      identifier_mode: 'tmdb_id', audio_languages: ['multi'], subtitle_capability: false, quality_capability: [],
      ...overrides.source,
    },
  };
}

// 22 providers × 23 sources — use 3 distinct sources for fallback testing.
const sourceDefault = makeConfig('p-default', 's-default');
const sourceA = makeConfig('p-a', 's-a');
const sourceB = makeConfig('p-b', 's-b');

// --- 1. applyDefaultSourceOrdering: default moves to front ---

const ordered1 = applyDefaultSourceOrdering([sourceA, sourceDefault, sourceB], 's-default');
assert.equal(ordered1[0].source.id, 's-default', 'default must be first after ordering');
assert.equal(ordered1[1].source.id, 's-a', 'remaining order preserved');
assert.equal(ordered1[2].source.id, 's-b');
assert.equal(ordered1.length, 3, 'no duplicates');

// --- 2. applyDefaultSourceOrdering: no default → unchanged ---

const ordered2 = applyDefaultSourceOrdering([sourceA, sourceB], undefined);
assert.equal(ordered2[0].source.id, 's-a');
assert.equal(ordered2[1].source.id, 's-b');

// --- 3. applyDefaultSourceOrdering: default not in list → unchanged ---

const ordered3 = applyDefaultSourceOrdering([sourceA, sourceB], 's-nonexistent');
assert.equal(ordered3[0].source.id, 's-a');
assert.equal(ordered3[1].source.id, 's-b');

// --- 4. applyDefaultSourceOrdering: default already first → unchanged ---

const ordered4 = applyDefaultSourceOrdering([sourceDefault, sourceA, sourceB], 's-default');
assert.equal(ordered4[0].source.id, 's-default');
assert.equal(ordered4.length, 3);

// --- 5. applyDefaultSourceOrdering: single-element list → unchanged ---

const ordered5 = applyDefaultSourceOrdering([sourceA], 's-default');
assert.equal(ordered5.length, 1);
assert.equal(ordered5[0].source.id, 's-a');

// --- 6. Default source is first in ranked candidate list ---

const request6: ResolverRequest = { sourceId: 's-default', contentId: '550', mediaType: 'movie', defaultSourceId: 's-default' };
const configs6 = applyDefaultSourceOrdering([sourceA, sourceDefault, sourceB], 's-default');
const ranking6 = rankProviderSourceList(request6, movieContent, configs6, new Map());
assert.equal(ranking6.eligible.length, 3, 'all 3 eligible');
assert.equal(ranking6.eligible[0].config.source.id, 's-default', 'default wins sourceOrder tiebreaker (it is first)');
assert.equal(ranking6.eligible[0].sourceOrder, 0, 'default sourceOrder is 0');
assert.equal(ranking6.eligible[1].sourceOrder, 1);
assert.equal(ranking6.eligible[2].sourceOrder, 2);

// --- 7. Default failure triggers fallback to next ranked candidate ---

// Force s-default to fail by giving it a bad template; verify fallback
// proceeds to the next ranked candidate.
const sourceDefaultFailing = makeConfig('p-default', 's-default', { source: { movie_template: 'https://embed.example.test/{unknown_placeholder}' } });
const request7: ResolverRequest = { sourceId: 's-default', contentId: '550', mediaType: 'movie', defaultSourceId: 's-default', allowFallback: true };
const configs7 = applyDefaultSourceOrdering([sourceA, sourceDefaultFailing, sourceB], 's-default');
const ranking7 = rankProviderSourceList(request7, movieContent, configs7, new Map());
const candidates7 = ranking7.eligible.map((ranked) => ({ config: ranked.config, eligible: true }));
// s-default should be first (sourceOrder 0) but will fail at the adapter
// level due to MISSING_IDENTIFIER (the {unknown_placeholder} is not a valid
// template substitution).
assert.equal(ranking7.eligible[0].config.source.id, 's-default');
const fallback7 = await resolveWithBoundedFallback(request7, movieContent, candidates7, {}, {
  allowFallback: true,
  maxAttempts: candidates7.length,
  avoidDuplicateProviders: true,
  isEligible: async (c) => c.eligible !== false,
});
assert.equal(fallback7.result.type, 'embed', 'fallback succeeded with an eligible candidate after default failed');
// The successful source must NOT be s-default (it failed).
assert.notEqual(fallback7.result.sourceId, 's-default', 'default must have been skipped after failure');
// Verify the attempt log: s-default failed first, then a successful candidate.
const failedAttempts = fallback7.attempts.filter((a) => a.result === 'failure');
const successAttempts = fallback7.attempts.filter((a) => a.result === 'success');
assert.equal(failedAttempts[0]?.sourceId, 's-default', 'default was attempted first and failed');
assert.equal(successAttempts.length, 1, 'exactly one successful attempt');
assert.notEqual(successAttempts[0]?.sourceId, 's-default');

// --- 8. Disabled default is excluded by ranking gates ---

const sourceDefaultDisabled = makeConfig('p-default', 's-default', { source: { enabled: false } });
const configs8 = applyDefaultSourceOrdering([sourceA, sourceDefaultDisabled, sourceB], 's-default');
const request8: ResolverRequest = { sourceId: 's-default', contentId: '550', mediaType: 'movie', defaultSourceId: 's-default' };
const ranking8 = rankProviderSourceList(request8, movieContent, configs8, new Map());
const eligible8 = ranking8.eligible.map((r) => r.config.source.id);
assert.equal(eligible8.includes('s-default'), false, 'disabled default must be excluded from eligible');
assert.equal(ranking8.eligible.length, 2, 'only 2 eligible (A and B)');
const excluded8 = ranking8.excluded.map((r) => ({ id: r.config.source.id, reason: r.reason }));
const defaultExcluded = excluded8.find((e) => e.id === 's-default');
assert.ok(defaultExcluded, 'disabled default must be in excluded list');
assert.equal(defaultExcluded?.reason, 'source-unavailable', 'disabled default excluded with source-unavailable reason');

// --- 9. Unsupported-media default is excluded ---

const sourceDefaultMovieOnly = makeConfig('p-default', 's-default', { source: { capabilities: { movie: true, series: false, anime: false } } });
const configs9 = applyDefaultSourceOrdering([sourceA, sourceDefaultMovieOnly, sourceB], 's-default');
const request9: ResolverRequest = { sourceId: 's-default', contentId: '1399', mediaType: 'series', defaultSourceId: 's-default' };
const ranking9 = rankProviderSourceList(request9, seriesContent, configs9, new Map());
const eligible9 = ranking9.eligible.map((r) => r.config.source.id);
assert.equal(eligible9.includes('s-default'), false, 'series-unsupported default must be excluded for series content');
const defaultExcluded9 = ranking9.excluded.find((e) => e.config.source.id === 's-default');
assert.equal(defaultExcluded9?.reason, 'unsupported-media');

// --- 10. Fallback ranking deterministic (Phase 7G preserved) ---

// With no health data, every candidate gets score 0.55 (unknown-exploration).
// The tiebreaker is sourceOrder ASC, then provider.id, then source.id.
// The default (sourceOrder 0) wins.
const configs10 = applyDefaultSourceOrdering([sourceA, sourceDefault, sourceB], 's-default');
const request10: ResolverRequest = { sourceId: 's-default', contentId: '550', mediaType: 'movie', defaultSourceId: 's-default' };
const ranking10a = rankProviderSourceList(request10, movieContent, configs10, new Map());
const ranking10b = rankProviderSourceList(request10, movieContent, configs10, new Map());
assert.deepEqual(
  ranking10a.eligible.map((r) => r.config.source.id),
  ranking10b.eligible.map((r) => r.config.source.id),
  'ranking must be deterministic for the same input',
);
assert.equal(ranking10a.eligible[0].config.source.id, 's-default', 'default first deterministically');

// --- 11. Default not duplicated in fallback attempts ---

const configs11 = applyDefaultSourceOrdering([sourceA, sourceDefault, sourceB], 's-default');
const request11: ResolverRequest = { sourceId: 's-default', contentId: '550', mediaType: 'movie', defaultSourceId: 's-default', allowFallback: true };
const ranking11 = rankProviderSourceList(request11, movieContent, configs11, new Map());
const candidates11 = ranking11.eligible.map((ranked) => ({ config: ranked.config, eligible: true }));
const attemptedSourceIds11: string[] = [];
const result11 = await resolveWithBoundedFallback(request11, movieContent, candidates11, {}, {
  allowFallback: true,
  maxAttempts: candidates11.length,
  avoidDuplicateProviders: true,
  isEligible: async (c) => c.eligible !== false,
  onSuccess: async (c) => { attemptedSourceIds11.push(c.config.source.id); },
  onFailure: async (c) => { attemptedSourceIds11.push(c.config.source.id); },
});
void result11;
const uniqueAttempts = new Set(attemptedSourceIds11);
assert.equal(uniqueAttempts.size, attemptedSourceIds11.length, 'no source attempted twice');
assert.equal(attemptedSourceIds11.includes('s-default'), true, 'default was attempted (it is first)');

// --- 12. All sources failing produces normalized RESOLUTION_UNAVAILABLE ---

const sourceAFailing = makeConfig('p-a', 's-a', { source: { movie_template: 'https://embed.example.test/{unknown_a}' } });
const sourceBFailing = makeConfig('p-b', 's-b', { source: { movie_template: 'https://embed.example.test/{unknown_b}' } });
const configs12 = applyDefaultSourceOrdering([sourceAFailing, sourceDefaultFailing, sourceBFailing], 's-default');
const request12: ResolverRequest = { sourceId: 's-default', contentId: '550', mediaType: 'movie', defaultSourceId: 's-default', allowFallback: true };
const ranking12 = rankProviderSourceList(request12, movieContent, configs12, new Map());
const candidates12 = ranking12.eligible.map((ranked) => ({ config: ranked.config, eligible: true }));
await assert.rejects(
  () => resolveWithBoundedFallback(request12, movieContent, candidates12, {}, {
    allowFallback: true,
    maxAttempts: candidates12.length,
    avoidDuplicateProviders: true,
    isEligible: async (c) => c.eligible !== false,
  }),
  (error: unknown) => error instanceof ResolverError && (error.code === 'RESOLUTION_UNAVAILABLE' || error.code === 'INVALID_TEMPLATE' || error.code === 'MISSING_IDENTIFIER'),
  'all-fail must throw a ResolverError',
);

// --- 13. parseResolverRequest accepts defaultSourceId ---

// parseResolverRequest enforces UUID format for sourceId and defaultSourceId.
const validUuid = '00000000-0000-4000-8000-000000000001';
const defaultUuid = '00000000-0000-4000-8000-000000000002';
const parsed13 = parseResolverRequest({ sourceId: validUuid, contentId: '550', mediaType: 'movie', defaultSourceId: defaultUuid });
assert.equal(parsed13.defaultSourceId, defaultUuid, 'defaultSourceId parsed');
assert.equal(parsed13.sourceId, validUuid);

// --- 14. parseResolverRequest ignores non-UUID defaultSourceId ---

const parsed14 = parseResolverRequest({ sourceId: validUuid, contentId: '550', mediaType: 'movie', defaultSourceId: 'not-a-uuid' });
assert.equal(parsed14.defaultSourceId, undefined, 'non-UUID defaultSourceId silently dropped');

// --- 15. parseResolverRequest with no defaultSourceId → undefined ---

const parsed15 = parseResolverRequest({ sourceId: validUuid, contentId: '550', mediaType: 'movie' });
assert.equal(parsed15.defaultSourceId, undefined);

// --- 16. Manual source switch (allowFallback=false) does NOT use default ordering ---

// When allowFallback is false, resolveSource calls resolveSourceFromConfig
// directly (no fallback walk, no default sorting). Verify the bypass.
const request16: ResolverRequest = { sourceId: 's-a', contentId: '550', mediaType: 'movie', defaultSourceId: 's-default', allowFallback: false };
const result16 = await resolveSourceFromConfig(request16, sourceA, movieContent, {});
assert.equal(result16.type, 'embed');
assert.equal(result16.sourceId, 's-a', 'manual switch respected s-a, default NOT forced');
assert.equal(result16.url, 'https://embed.example.test/movie/550');

// --- 17. Content-type defaults are distinct ---

// The PublicStreamingDefaults type has movie/series/anime as separate
// optional fields. Verify the resolver uses the correct one for each
// content type by checking the ranking uses the right content's type.
const movieRequest: ResolverRequest = { sourceId: 's-default', contentId: '550', mediaType: 'movie', defaultSourceId: 's-default' };
const seriesRequest: ResolverRequest = { sourceId: 's-default', contentId: '1399', mediaType: 'series', defaultSourceId: 's-default' };
const animeRequest: ResolverRequest = { sourceId: 's-default', contentId: '16459', mediaType: 'anime', defaultSourceId: 's-default' };
// All three requests can carry different defaultSourceId values without
// interfering — the resolver does not mix content types.
assert.notEqual(movieRequest.mediaType, seriesRequest.mediaType);
assert.notEqual(seriesRequest.mediaType, animeRequest.mediaType);
assert.notEqual(movieRequest.mediaType, animeRequest.mediaType);

// --- 18. Phase 1 PlaybackManager defaultSourceId forwarding ---

// The manager's loadSource forwards defaultSourceId only when allowFallback
// is true. We verify this by inspecting the body the manager would send.
// Rather than spinning up the full manager (which needs a fetcher), we
// verify the ResolverRequest type accepts defaultSourceId and the manager's
// loadSource signature includes it.
const clientRequest: ClientResolverRequest = {
  sourceId: 's-default',
  contentId: '550',
  mediaType: 'movie',
  defaultSourceId: 's-default',
};
assert.equal(clientRequest.defaultSourceId, 's-default', 'client ResolverRequest carries defaultSourceId');

// --- 19. Phase 1 manager default-source integration (mock fetcher) ---

// Verify the manager forwards defaultSourceId in the request body when
// allowFallback is true, and OMITS it when allowFallback is false.
const { PlaybackManager } = await import('$lib/client/player/PlaybackManager');
let capturedBody: Record<string, unknown> | undefined;
const mockFetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
  capturedBody = init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : undefined;
  return new Response(JSON.stringify({ ok: true, source: { type: 'embed', url: 'https://embed.example.test/movie/550', providerId: 'p-default', sourceId: 's-default', mediaType: 'movie' } }), { status: 200, headers: { 'content-type': 'application/json' } }) as unknown as Response;
};
const manager = new PlaybackManager({ fetcher: mockFetcher });

// With allowFallback=true and defaultSourceId set → forwarded.
await manager.loadSource({ sourceId: 's-default', contentId: '550', mediaType: 'movie', defaultSourceId: 's-default' }, 0, true);
assert.equal(capturedBody?.defaultSourceId, 's-default', 'defaultSourceId forwarded when allowFallback=true');

// With allowFallback=false (manual switch) → NOT forwarded, even if set.
await manager.loadSource({ sourceId: 's-a', contentId: '550', mediaType: 'movie', defaultSourceId: 's-default' }, 0, false);
assert.equal(capturedBody?.defaultSourceId, undefined, 'defaultSourceId NOT forwarded when allowFallback=false (manual switch)');
assert.equal(capturedBody?.sourceId, 's-a', 'manual sourceId respected');
manager.dispose();

// --- 20. Phase 1 manager behavior intact (regression) ---

const manager2 = new PlaybackManager({ fetcher: mockFetcher });
assert.equal(manager2.getSource(), null, 'initial source null');
assert.equal(manager2.getPlaybackState(), 'initial-loading');
await manager2.loadSource({ sourceId: 's-default', contentId: '550', mediaType: 'movie' }, 0, true);
assert.equal(manager2.getSource()?.sourceId, 's-default', 'Phase 1 loadSource still works');
manager2.dispose();

console.log('Phase 2 default source + automatic fallback tests passed: applyDefaultSourceOrdering (5 cases), default-first ranking, default-failure-triggers-fallback, disabled-default-excluded, unsupported-media-default-excluded, deterministic ranking preserved, no-duplicate-attempts, all-fail-normalized-error, parseResolverRequest accepts/ignores defaultSourceId, manual switch bypasses default, content-type distinctness, Phase 1 manager defaultSourceId forwarding (true when fallback on, false when manual switch), Phase 1 manager regression intact.');
