import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { ResolverError } from '$lib/server/resolver/errors';
import { createDefaultAdapterIds, createDefaultAdapters, createMockAdapter } from '$lib/server/resolver/adapters';
import { resolveWithBoundedFallback } from '$lib/server/resolver/fallback';
import {
  blueVelvetProviderAdapter,
  BLUEVELVET_ADAPTER_ID,
  BLUEVELVET_ORIGIN,
  buildBlueVelvetEndpoint,
  validateBlueVelvetMediaUrl,
  requestBlueVelvetMedia,
} from '$lib/server/resolver/bluevelvet';
import { PROVIDER_CAPABILITY_MAP, DIRECT_PLAYBACK_CAPABILITIES, lookupProviderCapabilities } from '$lib/shared/player-capabilities';
import { integrationTypes, identifierModes, providerStatuses, sourceVisibilities } from '$lib/shared/streaming';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { TrustedResolutionConfig } from '$lib/server/resolver/types';

// Blue Velvet provider integration tests (2026-10 production integration).
//
// Verified upstream contract (live probes recorded in bluevelvet.ts and the
// migration):
//   Movie: https://zcdn.bluevelvet.space/cdn?tmdb={tmdbId}&type=movie
//   TV:    https://zcdn.bluevelvet.space/cdn?tmdb={tmdbId}&type=tv&season={s}&episode={e}
//   200 {"ready":true,"url":"…/play/{token}/master.m3u8"}; 202 {"ready":false,…};
//   400 {"error":"need tmdb"}. CORS: upstream allowlists foreign origins
//   (cinecat.eu verified) but NOT Mavero's — the source is seeded DISABLED.
//
// All upstream responses are MOCKED (globalThis.fetch stubs) — no live
// third-party dependency, matching the repository's deterministic test
// conventions.

const providerId = '00000000-0000-4000-8000-00000000b100';
const otherProviderId = '00000000-0000-4000-8000-00000000b200';
const sourceId = '00000000-0000-4000-8000-00000000b101';

// Mirrors migration 20261112000000_blue_velvet_provider.sql exactly.
const capabilities = {
  movie: true,
  series: true,
  anime: true,
  result_type: 'direct',
  supports_episode: true,
  supports_direct: true,
  supports_server_selection: false,
  automatic_server_fallback: false,
  supports_subtitles: false,
  supports_language_selection: false,
  supports_download: false,
  allow_experimental_playback: false,
};

function blueVelvetConfig(overrides?: {
  providerEnabled?: boolean;
  providerStatus?: string;
  sourceEnabled?: boolean;
  sourceStatus?: string;
}): TrustedResolutionConfig {
  return {
    provider: {
      id: providerId,
      name: 'Blue Velvet',
      status: (overrides?.providerStatus ?? 'experimental') as 'experimental',
      enabled: overrides?.providerEnabled ?? false,
      integration_type: 'api' as const,
      adapter_id: 'blue-velvet',
      capabilities,
    },
    source: {
      id: sourceId,
      provider_id: providerId,
      name: 'Blue Velvet',
      status: (overrides?.sourceStatus ?? 'experimental') as 'experimental',
      enabled: overrides?.sourceEnabled ?? false,
      visibility: 'public' as const,
      integration_type: 'api' as const,
      capabilities,
      movie_template: null,
      series_template: null,
      anime_template: null,
      identifier_mode: 'tmdb_id' as const,
      audio_languages: [],
      subtitle_capability: false,
      quality_capability: [],
    },
  };
}

function content(type: 'movie' | 'series', tmdb?: string): NormalizedMediaItem {
  return {
    id: `bv-fixture-${tmdb ?? 'none'}`,
    title: 'Fixture title',
    year: 2024,
    type,
    runtime: '120 min',
    rating: 8,
    genres: ['Drama'],
    description: 'Fixture',
    poster: 'https://image.example.test/poster.jpg',
    backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#ffffff',
    source: { provider: 'tmdb', externalId: tmdb, fetchedAt: new Date().toISOString() },
    externalIds: { tmdb },
  };
}

const MASTER_URL = `${BLUEVELVET_ORIGIN}/play/akjY7K7bFpyzk9-b.owuLyJbrr-Jy2S35kHmkq1SmhYokLqd0c1njLrh9kG6xaSRbyAe25jB1vliq/master.m3u8`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const realFetch = globalThis.fetch;
let currentFetch: typeof globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => currentFetch(input, init)) as typeof fetch;
let lastEndpoint = '';
// Remaining fixes (2026-10): the adapter ALSO fetches the resolved master
// playlist (variant discovery) — record every fetch in order so endpoint
// assertions can address the API call specifically (fetch #1) instead of
// "the last fetch seen" (now the master).
const fetchLog: string[] = [];
let lastInit: RequestInit | undefined;

/** Installs a fetch stub returning the given responses; records the request. */
function useFetch(handler: (endpoint: string, init?: RequestInit) => Response | Promise<Response>): void {
  currentFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    lastEndpoint = String(input instanceof URL ? input : input);
    fetchLog.push(lastEndpoint);
    lastInit = init;
    return handler(lastEndpoint, init);
  }) as typeof fetch;
}

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}
async function expectError(promise: Promise<unknown>, code: string, label: string) {
  let threw = false;
  try {
    await promise;
  } catch (error) {
    threw = true;
    ok(error instanceof ResolverError && error.code === code, `${label} → ${code} (got ${(error as Error).message})`);
  }
  if (!threw) assert.fail(`${label}: expected ResolverError ${code} but the promise resolved`);
}

// ============================================================
// §1 — Endpoint construction
// ============================================================

ok(buildBlueVelvetEndpoint('27205', 'movie') === `${BLUEVELVET_ORIGIN}/cdn?tmdb=27205&type=movie`, '§1 movie endpoint exact');
ok(
  buildBlueVelvetEndpoint('1399', 'tv', 2, 5) === `${BLUEVELVET_ORIGIN}/cdn?tmdb=1399&type=tv&season=2&episode=5`,
  '§1 tv endpoint exact (tmdb + type + season + episode)',
);
ok(new URL(buildBlueVelvetEndpoint('27205', 'movie')).origin === BLUEVELVET_ORIGIN, '§1 endpoint origin pinned to the constant');
{
  const url = new URL(buildBlueVelvetEndpoint('1399', 'tv', 1, 1));
  ok(url.searchParams.get('tmdb') === '1399', '§1 param name tmdb');
  ok(url.searchParams.get('type') === 'tv', '§1 param name type=tv');
  ok(url.searchParams.get('season') === '1', '§1 param name season');
  ok(url.searchParams.get('episode') === '1', '§1 param name episode');
  ok([...url.searchParams.keys()].every((key) => ['tmdb', 'type', 'season', 'episode'].includes(key)), '§1 no extra query parameters');
}
// Malformed / missing TMDB ids → MISSING_IDENTIFIER.
for (const bad of [undefined, '', ' ', 'notanumber', '0', '-5', '12x', '007', '1'.repeat(17), '1e3', '+1', '1.5']) {
  expectError(
    (async () => buildBlueVelvetEndpoint(bad as string, 'movie'))(),
    'MISSING_IDENTIFIER',
    `§1 tmdb ${JSON.stringify(bad ?? null)} rejected`,
  );
}
// Missing / zero / negative / malformed season & episode → MISSING_IDENTIFIER.
for (const [season, episode] of [[undefined, 1], [1, undefined], [0, 1], [1, 0], [-1, 1], [1, -1], [1.5, 1], [Number.NaN, 1]] as Array<[number | undefined, number | undefined]>) {
  expectError(
    (async () => buildBlueVelvetEndpoint('1399', 'tv', season, episode))(),
    'MISSING_IDENTIFIER',
    `§1 tv s=${String(season)} e=${String(episode)} rejected`,
  );
}
await Promise.resolve();
ok(new URL(buildBlueVelvetEndpoint('1399', 'tv', 2 ** 31 - 1, 1)).searchParams.get('season') === String(2 ** 31 - 1), '§1 large season passes through unchanged');

// ============================================================
// §2 — Response contract handling (mocked upstream)
// ============================================================

useFetch(() => jsonResponse({ ready: true, url: MASTER_URL }));
ok((await requestBlueVelvetMedia(buildBlueVelvetEndpoint('27205', 'movie'))) === MASTER_URL, '§2 ready:true returns validated media URL');
ok(lastInit?.signal !== undefined, '§2 upstream call carries an abort signal (bounded)');
ok((lastInit?.headers as Record<string, string>).accept === 'application/json', '§2 upstream call requests JSON');
ok(lastInit?.redirect === 'error', '§2 upstream call refuses redirects');

useFetch(() => jsonResponse({ ready: false, status: 'building' }, 202));
await expectError(requestBlueVelvetMedia(buildBlueVelvetEndpoint('27205', 'movie')), 'RESOLUTION_UNAVAILABLE', '§2 ready:false (building, 202) unavailable');

useFetch(() => jsonResponse({ ready: false, status: 'queued' }, 202));
await expectError(requestBlueVelvetMedia(buildBlueVelvetEndpoint('27205', 'movie')), 'RESOLUTION_UNAVAILABLE', '§2 ready:false (queued) unavailable');

useFetch(() => jsonResponse({ ready: true }));
await expectError(requestBlueVelvetMedia(buildBlueVelvetEndpoint('27205', 'movie')), 'PROVIDER_RESPONSE_INVALID', '§2 missing url invalid');

useFetch(() => jsonResponse({ ready: true, url: '' }));
await expectError(requestBlueVelvetMedia(buildBlueVelvetEndpoint('27205', 'movie')), 'PROVIDER_RESPONSE_INVALID', '§2 empty url invalid');

useFetch(() => jsonResponse({ ready: true, url: 42 }));
await expectError(requestBlueVelvetMedia(buildBlueVelvetEndpoint('27205', 'movie')), 'PROVIDER_RESPONSE_INVALID', '§2 non-string url invalid');

useFetch(() => jsonResponse({ url: MASTER_URL }));
await expectError(requestBlueVelvetMedia(buildBlueVelvetEndpoint('27205', 'movie')), 'PROVIDER_RESPONSE_INVALID', '§2 missing ready flag invalid');

useFetch(() => jsonResponse('not json at all'));
await expectError(requestBlueVelvetMedia(buildBlueVelvetEndpoint('27205', 'movie')), 'PROVIDER_RESPONSE_INVALID', '§2 invalid JSON body invalid');

useFetch(() => new Response('<html>gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
await expectError(requestBlueVelvetMedia(buildBlueVelvetEndpoint('27205', 'movie')), 'PROVIDER_RESPONSE_INVALID', '§2 unexpected content type invalid');

useFetch(() => jsonResponse([1, 2, 3]));
await expectError(requestBlueVelvetMedia(buildBlueVelvetEndpoint('27205', 'movie')), 'PROVIDER_RESPONSE_INVALID', '§2 array payload invalid');

useFetch(() => jsonResponse({ error: 'need tmdb' }, 400));
await expectError(requestBlueVelvetMedia(buildBlueVelvetEndpoint('27205', 'movie')), 'PROVIDER_RESPONSE_INVALID', '§2 upstream 4xx invalid');

useFetch(() => jsonResponse({ error: 'boom' }, 500));
await expectError(requestBlueVelvetMedia(buildBlueVelvetEndpoint('27205', 'movie')), 'RESOLUTION_UNAVAILABLE', '§2 upstream 5xx unavailable');

useFetch(() => jsonResponse({ error: 'rate limited' }, 429));
await expectError(requestBlueVelvetMedia(buildBlueVelvetEndpoint('27205', 'movie')), 'PROVIDER_RESPONSE_INVALID', '§2 upstream 429 invalid');

useFetch(() => {
  const timeout = new Error('The operation was aborted due to timeout');
  timeout.name = 'TimeoutError';
  throw timeout;
});
await expectError(requestBlueVelvetMedia(buildBlueVelvetEndpoint('27205', 'movie')), 'RESOLUTION_TIMEOUT', '§2 fetch timeout typed');

useFetch(() => {
  throw new TypeError('fetch failed');
});
await expectError(requestBlueVelvetMedia(buildBlueVelvetEndpoint('27205', 'movie')), 'RESOLUTION_UNAVAILABLE', '§2 network failure unavailable');

// ============================================================
// §3 — Returned media URL validation
// ============================================================

ok(validateBlueVelvetMediaUrl(MASTER_URL) === MASTER_URL, '§3 observed live master URL accepted');
ok(
  validateBlueVelvetMediaUrl(`${BLUEVELVET_ORIGIN}/play/short-tok/master.m3u8`) === `${BLUEVELVET_ORIGIN}/play/short-tok/master.m3u8`,
  '§3 conservative token charset accepted',
);
for (const bad of [
  'http://zcdn.bluevelvet.space/play/abc123/master.m3u8', // http
  'https://evil.example.test/play/abc123/master.m3u8', // foreign host
  'https://zcdn.bluevelvet.space.evil.test/play/abc/master.m3u8', // suffix-spoofed host
  `https://zcdn.bluevelvet.space@evil.example.test/play/abc/master.m3u8`, // userinfo host
  'https://user:pass@zcdn.bluevelvet.space/play/abc/master.m3u8', // embedded credentials
  'https://zcdn.bluevelvet.space/play/abc123/episode.m3u8', // unexpected playlist leaf
  'https://zcdn.bluevelvet.space/other/abc123/master.m3u8', // unexpected path prefix
  'https://zcdn.bluevelvet.space/play/abc123/extra/master.m3u8', // extra path segment
  'https://zcdn.bluevelvet.space/play/../etc/master.m3u8', // traversal attempt
  'https://zcdn.bluevelvet.space/play/abc123/master.m3u8?token=x', // unexpected query
  'https://zcdn.bluevelvet.space/play/abc123/master.m3u8#frag', // unexpected hash
  'ftp://zcdn.bluevelvet.space/play/abc123/master.m3u8', // unsupported scheme
  'not a url at all', // malformed
  'file:///play/abc123/master.m3u8', // non-http scheme
]) {
  expectError((async () => validateBlueVelvetMediaUrl(bad))(), 'INVALID_SOURCE_URL', `§3 rejects ${bad.slice(0, 58)}`);
}
await Promise.resolve();

// ============================================================
// §4 — Resolver integration (registry dispatch + lifecycle gates)
// ============================================================

const adapterIds = createDefaultAdapterIds();
ok(adapterIds[BLUEVELVET_ADAPTER_ID] === blueVelvetProviderAdapter, '§4 adapter registered under "blue-velvet"');
ok(blueVelvetProviderAdapter.integrationType === 'api', '§4 adapter integration type api');
ok(adapterIds['vidsrc-embed'] && adapterIds['vidlink-embed'] && adapterIds['vidara'] && adapterIds['abyss'], '§4 existing adapter registrations intact');
ok(lookupProviderCapabilities('blue-velvet') === DIRECT_PLAYBACK_CAPABILITIES, '§4 admin capability matrix maps blue-velvet to verified direct set');
ok(PROVIDER_CAPABILITY_MAP['blue-velvet'] === DIRECT_PLAYBACK_CAPABILITIES, '§4 capability map entry exact');
ok(
  /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(BLUEVELVET_ADAPTER_ID) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test('blue-velvet') && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test('blue-velvet-hls'),
  '§4 adapter id + slugs satisfy the DB check constraints',
);
ok(integrationTypes.includes('api') && identifierModes.includes('tmdb_id') && providerStatuses.includes('experimental') && sourceVisibilities.includes('public'), '§4 seeded enum values valid per shared constants');

// Disabled-by-default lifecycle gates (migration seeds BOTH disabled).
useFetch(() => jsonResponse({ ready: true, url: MASTER_URL }));
await expectError(
  resolveSourceFromConfig({ sourceId, contentId: 'c1', mediaType: 'movie' }, blueVelvetConfig(), content('movie', '27205')),
  'PROVIDER_DISABLED',
  '§4 provider disabled gate',
);
await expectError(
  resolveSourceFromConfig(
    { sourceId, contentId: 'c2', mediaType: 'movie' },
    blueVelvetConfig({ providerEnabled: true, providerStatus: 'active' }),
    content('movie', '27205'),
  ),
  'SOURCE_DISABLED',
  '§4 source disabled gate',
);
await expectError(
  resolveSourceFromConfig(
    { sourceId, contentId: 'c3', mediaType: 'movie' },
    blueVelvetConfig({ providerEnabled: true, providerStatus: 'active', sourceEnabled: true, sourceStatus: 'maintenance' }),
    content('movie', '27205'),
  ),
  'SOURCE_MAINTENANCE',
  '§4 non-active source status gate',
);

// Enabled + active: full success through the REAL resolver core.
useFetch(() => jsonResponse({ ready: true, url: MASTER_URL }));
const movie = await resolveSourceFromConfig(
  { sourceId, contentId: '27205', mediaType: 'movie' },
  blueVelvetConfig({ providerEnabled: true, providerStatus: 'active', sourceEnabled: true, sourceStatus: 'active' }),
  content('movie', '27205'),
);
ok(movie.type === 'direct', '§4 movie resolves as direct');
ok(movie.url === MASTER_URL, '§4 movie URL is the validated master playlist');
ok(movie.metadata?.protocol === 'hls', '§4 metadata.protocol hls (the player-consumed protocol field)');
ok(movie.metadata?.sourceName === 'Blue Velvet' && movie.metadata?.providerName === 'Blue Velvet', '§4 metadata names exact "Blue Velvet"');
ok(movie.qualities === undefined && movie.subtitles === undefined, '§4 no hardcoded qualities/subtitles advertised (manifest discovery only)');

useFetch(() => jsonResponse({ ready: true, url: MASTER_URL }));
const tv = await resolveSourceFromConfig(
  { sourceId, contentId: '1399', mediaType: 'series', season: 1, episode: 3 },
  blueVelvetConfig({ providerEnabled: true, providerStatus: 'active', sourceEnabled: true, sourceStatus: 'active' }),
  content('series', '1399'),
);
ok(tv.type === 'direct' && tv.url === MASTER_URL, '§4 tv episode resolves as direct');
ok(
  fetchLog[fetchLog.length - 2] === `${BLUEVELVET_ORIGIN}/cdn?tmdb=1399&type=tv&season=1&episode=3`,
  '§4 tv resolution used the episode endpoint (type=tv&season&episode) — fetch #1; fetch #2 is the variant-discovery master fetch',
);
{
  const movieEndpointProbe = new URL(fetchLog[fetchLog.length - 2]);
  ok(movieEndpointProbe.searchParams.get('type') === 'tv', '§4 endpoint type param reflects the requested media type');
}
// Remaining fixes (2026-10): the master fetch happened and DEGRADED to no
// qualities (this stub answers JSON for every URL → not a playlist → []).
ok(
  fetchLog[fetchLog.length - 1] === MASTER_URL,
  '§4 variant discovery fetched the validated master URL (degrades to no qualities on non-playlist bodies)',
);

// Identifier discipline: missing TMDB id and missing season/episode are
// rejected BEFORE any upstream call (upstream would silently serve episode 1).
useFetch(() => {
  assert.fail('§4 upstream must not be called for invalid identifiers');
});
await expectError(
  resolveSourceFromConfig(
    { sourceId, contentId: 'x1', mediaType: 'movie' },
    blueVelvetConfig({ providerEnabled: true, providerStatus: 'active', sourceEnabled: true, sourceStatus: 'active' }),
    content('movie'),
  ),
  'MISSING_IDENTIFIER',
  '§4 movie without tmdb id rejected',
);
await expectError(
  resolveSourceFromConfig(
    { sourceId, contentId: 'x2', mediaType: 'series', season: 2 },
    blueVelvetConfig({ providerEnabled: true, providerStatus: 'active', sourceEnabled: true, sourceStatus: 'active' }),
    content('series', '1399'),
  ),
  'MISSING_IDENTIFIER',
  '§4 series without episode rejected',
);
await expectError(
  resolveSourceFromConfig(
    { sourceId, contentId: 'x3', mediaType: 'series', season: 0, episode: 1 },
    blueVelvetConfig({ providerEnabled: true, providerStatus: 'active', sourceEnabled: true, sourceStatus: 'active' }),
    content('series', '1399'),
  ),
  'MISSING_IDENTIFIER',
  '§4 series with season 0 rejected',
);

// Ready:false flows through the resolver as a typed candidate failure.
useFetch(() => jsonResponse({ ready: false, status: 'building' }, 202));
await expectError(
  resolveSourceFromConfig(
    { sourceId, contentId: 'x4', mediaType: 'movie' },
    blueVelvetConfig({ providerEnabled: true, providerStatus: 'active', sourceEnabled: true, sourceStatus: 'active' }),
    content('movie', '27205'),
  ),
  'RESOLUTION_UNAVAILABLE',
  '§4 ready:false resolution unavailable',
);

// ============================================================
// §5 — Fallback semantics: Blue Velvet failure never breaks other sources
// ============================================================

const fallbackProvider = {
  id: otherProviderId,
  name: 'Fixture Embed',
  status: 'active' as const,
  enabled: true,
  integration_type: 'template' as const,
  adapter_id: null,
  capabilities: { ...capabilities, result_type: 'embed', supports_direct: false, allowed_embed_origins: ['https://fixture.example.test'] },
};
const fallbackSource = {
  id: '00000000-0000-4000-8000-00000000b201',
  provider_id: otherProviderId,
  name: 'Fixture Embed',
  status: 'active' as const,
  enabled: true,
  visibility: 'public' as const,
  integration_type: 'template' as const,
  capabilities: { ...capabilities, result_type: 'embed', supports_direct: false, allowed_embed_origins: ['https://fixture.example.test'] },
  movie_template: 'https://fixture.example.test/movie/{tmdb_id}',
  series_template: 'https://fixture.example.test/tv/{tmdb_id}/{season}/{episode}',
  anime_template: null,
  identifier_mode: 'tmdb_id' as const,
  audio_languages: ['multi'],
  subtitle_capability: false,
  quality_capability: [],
};
const dependencies = { adapters: { template: createMockAdapter('template', { type: 'embed', url: 'https://fixture.example.test/movie/27205' }) } };

// Blue Velvet upstream failure → the bounded fallback walk proceeds to the
// healthy fixture source and the final result is the fixture's.
useFetch(() => jsonResponse({ error: 'upstream down' }, 503));
const fallbackRun = await resolveWithBoundedFallback(
  { sourceId, contentId: '27205', mediaType: 'movie' },
  content('movie', '27205'),
  [
    { config: blueVelvetConfig({ providerEnabled: true, providerStatus: 'active', sourceEnabled: true, sourceStatus: 'active' }) },
    { config: { provider: fallbackProvider, source: fallbackSource } },
  ],
  dependencies,
);
ok(fallbackRun.result.type === 'embed' && fallbackRun.result.url === 'https://fixture.example.test/movie/27205', '§5 fallback served the healthy fixture source');
ok(fallbackRun.attempts[0]?.sourceId === sourceId && fallbackRun.attempts[0]?.result === 'failure', '§5 blue velvet attempt recorded as failure');
ok(fallbackRun.attempts[0]?.errorCode === 'RESOLUTION_UNAVAILABLE', '§5 blue velvet failure carries the typed code');

// ready:false (deterministic-ish unavailability) also falls through.
useFetch(() => jsonResponse({ ready: false, status: 'queued' }, 202));
const fallbackRun2 = await resolveWithBoundedFallback(
  { sourceId: '00000000-0000-4000-8000-00000000b299', contentId: '1399', mediaType: 'series', season: 1, episode: 1 },
  content('series', '1399'),
  [
    { config: { ...blueVelvetConfig({ providerEnabled: true, providerStatus: 'active', sourceEnabled: true, sourceStatus: 'active' }), source: { ...blueVelvetConfig({ providerEnabled: true }).source, id: '00000000-0000-4000-8000-00000000b299' } } },
    { config: { provider: fallbackProvider, source: fallbackSource } },
  ],
  { adapters: { template: createMockAdapter('template', { type: 'embed', url: 'https://fixture.example.test/tv/1399/1/1' }) } },
);
ok(fallbackRun2.result.type === 'embed', '§5 ready:false falls through to the next candidate');

// ============================================================
// §6 — Existing adapters unaffected (regression guard)
// ============================================================

const genericAdapters = createDefaultAdapters();
ok(genericAdapters.template && genericAdapters.api && genericAdapters.direct && genericAdapters.embed && genericAdapters.custom, '§6 default integration-type adapters unchanged');
ok(genericAdapters.api !== blueVelvetProviderAdapter, '§6 generic api adapter untouched (blue velvet dispatches by adapter id only)');
ok(adapterIds['vidsrc-embed'] === (await import('$lib/server/resolver/vidsrc')).vidsrcProviderAdapter, '§6 vidsrc registration identity unchanged');

// ============================================================
// §7 — Migration contract (idempotent, linked, disabled, forward-only)
// ============================================================

const migrationPath = 'supabase/migrations/20261112000000_blue_velvet_provider.sql';
const migration = readFileSync(resolve(migrationPath), 'utf-8');
ok(/^\d{14}_blue_velvet_provider\.sql$/.test(migrationPath.split('/').pop() ?? ''), '§7 migration naming convention');
ok(Number(migrationPath.split('/').pop()?.slice(0, 14)) > 20261107000000, '§7 migration sorts after the latest existing migration');
ok(migration.includes("'Blue Velvet'"), '§7 provider display name exact');
ok(migration.includes("'blue-velvet'"), '§7 provider slug + adapter id exact');
ok(migration.includes("'blue-velvet-hls'"), '§7 source slug exact');
ok(migration.includes("'api'"), '§7 integration_type api');
ok(migration.includes("'result_type', 'direct'"), '§7 direct result capability');
ok(/insert into public\.streaming_providers[\s\S]*on conflict \(slug\) do nothing/.test(migration), '§7 provider insert conflict-safe (idempotent)');
ok(/insert into public\.streaming_sources[\s\S]*on conflict \(provider_id, slug\) do nothing/.test(migration), '§7 source insert conflict-safe (idempotent)');
ok(/where provider\.slug = 'blue-velvet'/.test(migration), '§7 source links to the provider row via slug lookup (FK integrity)');
ok(migration.includes("'tmdb_id'"), '§7 identifier mode tmdb');
ok(!/delete from/i.test(migration), '§7 forward-only: no deletes');
ok(!/update public\.streaming_/i.test(migration), '§7 forward-only: no updates to existing provider/source rows');
// Seeded DISABLED (provider AND source) until upstream CORS is verified.
{
  const providerBlock = migration.slice(migration.indexOf('insert into public.streaming_providers'), migration.indexOf('insert into public.streaming_sources'));
  const sourceBlock = migration.slice(migration.indexOf('insert into public.streaming_sources'));
  ok(/,\s*false,\s*'api',/.test(providerBlock.replace(/\n/g, ' ')), '§7 provider seeded enabled=false');
  ok(/\n\s{4}false,\s*\n\s{4}'public',/.test(sourceBlock), '§7 source seeded enabled=false');
}
ok(migration.includes('400'), '§7 ordering 400 (behind every existing seeded source)');
ok(migration.includes('cinecat.eu') || migration.includes('CORS'), '§7 CORS limitation documented in the migration');

// ============================================================
// §8 — Public-config / selector contract
// ============================================================

// The user-facing selector derives the label from streaming_sources.name and
// the status from streaming_sources.status — assert the seeded names.
ok(blueVelvetConfig().source.name === 'Blue Velvet', '§8 user-facing source label exactly "Blue Velvet"');
ok(blueVelvetConfig().provider.name === 'Blue Velvet', '§8 provider display name exactly "Blue Velvet"');
ok(blueVelvetConfig().source.visibility === 'public', '§8 source visibility public (selector-eligible shape)');
ok(blueVelvetConfig().source.integration_type === 'api', '§8 source integration type api (matches provider)');

// ============================================================
// §9 — Experimental-status eligibility gates (MAV-BV-PLAYBACK,
//      2026-10-12 live verification)
//
// The PRODUCTION rows were found in an "enabled but ineligible" shape:
//   provider + source: enabled=true, status='experimental',
//   capabilities.allow_experimental_playback=false (both)
// resolveSourceFromConfig rejects that shape at the provider-status gate
// (core.ts providerStatusAllowsPlayback: status must be 'active' OR
// experimental WITH allow_experimental_playback) BEFORE the adapter is
// called — verified live against the deployed /api/playback/resolve
// (HTTP 409 PROVIDER_DISABLED for the blue-velvet-hls source). These
// checks pin that gate behavior so the lifecycle can never silently drift:
// the repo convention for playable experimental sources (abyss, vidara,
// vidzee) is provider-level allow_experimental_playback=true.
// ============================================================

{
  const liveShapedConfig = blueVelvetConfig({ providerEnabled: true, sourceEnabled: true });
  useFetch(() => {
    throw new Error('§9 upstream must never be reached while the experimental gate rejects the rows');
  });
  await expectError(
    resolveSourceFromConfig({ sourceId, contentId: 'live-1', mediaType: 'movie' }, liveShapedConfig, content('movie', '27205')),
    'PROVIDER_DISABLED',
    '§9 live row shape (experimental + no allow_experimental_playback on either) gated as PROVIDER_DISABLED before the adapter',
  );

  // Repo convention for playable experimental sources: provider-level
  // allow_experimental_playback=true (abyss/vidara/vidzee production shape).
  const providerAllowedConfig = blueVelvetConfig({ providerEnabled: true, sourceEnabled: true });
  providerAllowedConfig.provider.capabilities = { ...capabilities, allow_experimental_playback: true };
  useFetch(() => jsonResponse({ ready: true, url: MASTER_URL }));
  const providerAllowed = await resolveSourceFromConfig(
    { sourceId, contentId: 'live-2', mediaType: 'movie' },
    providerAllowedConfig,
    content('movie', '27205'),
  );
  ok(providerAllowed.type === 'direct' && providerAllowed.url === MASTER_URL, '§9 provider-level allow_experimental_playback=true passes the gate (repo convention)');

  // Source-level allowance also satisfies the gate (either side may grant it).
  const sourceAllowedConfig = blueVelvetConfig({ providerEnabled: true, sourceEnabled: true });
  sourceAllowedConfig.source.capabilities = { ...capabilities, allow_experimental_playback: true };
  useFetch(() => jsonResponse({ ready: true, url: MASTER_URL }));
  const sourceAllowed = await resolveSourceFromConfig(
    { sourceId, contentId: 'live-3', mediaType: 'movie' },
    sourceAllowedConfig,
    content('movie', '27205'),
  );
  ok(sourceAllowed.type === 'direct' && sourceAllowed.url === MASTER_URL, '§9 source-level allow_experimental_playback=true passes the gate');

  // Either-side allowance semantics: with the provider-level grant present,
  // a maintenance source passes the source-status gate as well (core.ts
  // experimentalPlaybackAllowed ORs provider and source capabilities) — the
  // grant is a lifecycle decision, not a per-row accident.
  const maintenanceConfig = blueVelvetConfig({ providerEnabled: true, sourceEnabled: true });
  maintenanceConfig.provider.capabilities = { ...capabilities, allow_experimental_playback: true };
  maintenanceConfig.source.status = 'maintenance';
  useFetch(() => jsonResponse({ ready: true, url: MASTER_URL }));
  const maintenance = await resolveSourceFromConfig(
    { sourceId, contentId: 'live-4', mediaType: 'movie' },
    maintenanceConfig,
    content('movie', '27205'),
  );
  ok(maintenance.type === 'direct' && maintenance.url === MASTER_URL, '§9 provider-level grant also covers a maintenance source (either-side OR semantics)');
}

// ============================================================
// §10 — Deployment CSP contract for the Blue Velvet media origin
//       (MAV-BV-PLAYBACK, 2026-10-12)
//
// Verified live with a real Chromium against the EXACT deployed CSP:
//   * media element loads (<video src>) were rejected because media-src was
//     absent (falls back to default-src 'self');
//   * hls.js XHR/fetch loads were rejected by connect-src.
// The fix adds media-src + connect-src entries for the FIXED adapter origin.
// These checks pin the deployment header so a CSP edit can never again
// silently break direct HLS playback.
// ============================================================

{
  const netlifyToml = readFileSync(resolve('netlify.toml'), 'utf-8');
  const cspMatch = netlifyToml.match(/Content-Security-Policy\s*=\s*"([^"]+)"/);
  ok(cspMatch !== null, '§10 netlify.toml carries a Content-Security-Policy header');
  if (cspMatch) {
    const csp = cspMatch[1];
    const directive = (name: string) => {
      const m = csp.match(new RegExp(`(?:^|;)\\s*${name}\\s+([^;]*)`, 'i'));
      return m ? m[1].trim().split(/\s+/) : null;
    };
    // media-src MUST exist explicitly: when absent it falls back to
    // default-src 'self', which rejects the cross-origin media element load
    // (native-HLS browsers) — verified live.
    const mediaSrc = directive('media-src');
    ok(mediaSrc !== null, '§10 media-src directive present (native-HLS media elements)');
    ok(mediaSrc?.includes('https://zcdn.bluevelvet.space') === true, '§10 media-src allows the fixed Blue Velvet origin');
    const connectSrc = directive('connect-src');
    ok(connectSrc?.includes('https://zcdn.bluevelvet.space') === true, '§10 connect-src allows the fixed Blue Velvet origin (hls.js XHR route)');
    // Player V2 final remediation (2026-10-13): the browser-direct optional
    // lookups — VDRK subtitle LISTS (files ride the same-origin proxy) and
    // TheIntroDB — were missing from connect-src, so the deployed CSP
    // rejected both fetches before they left the page (the reported "no
    // usable subtitles / no Skip Intro" on every title). The origins are
    // the clients' fixed HTTPS constants; pinned here so a future CSP edit
    // cannot silently break the lookups again.
    ok(connectSrc?.includes('https://sub.vdrk.site') === true, '§10 connect-src allows the fixed VDRK subtitle-list origin (browser-direct list fetch)');
    ok(connectSrc?.includes('https://api.theintrodb.org') === true, '§10 connect-src allows the fixed TheIntroDB origin (browser-direct intro lookup)');
    // Security regressions guarded while the playback entries are added.
    ok(directive('default-src')?.includes("'self'") === true, '§10 default-src remains self');
    ok(directive('frame-ancestors')?.includes("'none'") === true, '§10 frame-ancestors none unchanged');
    ok(!mediaSrc?.includes('*') && !connectSrc?.includes('*'), '§10 no wildcard relaxation introduced in media-src/connect-src');
    ok(!/http:\/\//.test(mediaSrc?.join(' ') ?? '') && !/http:\/\//.test(connectSrc?.join(' ') ?? ''), '§10 no plaintext (non-HTTPS) origins added to media-src/connect-src');
  }
}

// ============================================================
// Summary
// ============================================================

globalThis.fetch = realFetch;
console.log(`bluevelvet_provider_test: ${passed} checks passed`);
