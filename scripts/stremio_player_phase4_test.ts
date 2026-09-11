import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import type { PlayerSource } from '$lib/shared/player';
import { isPlayablePlayerSource } from '$lib/shared/player-guards';
import { MAVERO_PLAYER_INTEGRATION_TYPE, MAVERO_PLAYER_SOURCE_ID, MAVERO_PLAYER_SOURCE_NAME, isMaveroPlayerSourceId, maveroPlayerSourceOption } from '$lib/shared/mavero-player';
import { MAVERO_PLAYER_MAX_STREAMS, MAVERO_PLAYER_STREAMS_PER_ADDON, hasStreamEligibleAddons, maveroPlayerSourceFromResolution, parseStremioPlaybackRequest } from '$lib/server/streaming/stremio/mavero-player-source';
import { resolveStremioStreams, type StremioResolvedStream, type StremioStreamResolution } from '$lib/server/streaming/stremio/stream-resolver';
import { stremioStreamToPlayerSource } from '$lib/server/streaming/stremio/stream-player-source';
import { parseResolverRequest } from '$lib/server/resolver/identifiers';
import { validatePlaybackUrl } from '$lib/server/resolver/safe-url';
import { DIRECT_PLAYBACK_CAPABILITIES, EMBED_PLAYBACK_CAPABILITIES } from '$lib/client/player/capabilities';
import { PlaybackManager } from '$lib/client/player/PlaybackManager';
import { resolveMaveroPlayerSource } from '$lib/client/player/mavero-player';

// Phase 4: MAVERO Player integration tests.
//
// Scope: the ADDITIVE integration between the completed Phase 3 Stremio
// HTTP stream resolver and the EXISTING playback architecture:
//   * the virtual "MAVERO Player" source identity (stable, non-UUID — it
//     can never enter the existing /api/playback/resolve id space),
//   * server-side request parsing (content identifiers ONLY),
//   * composition of resolved Stremio streams into ONE aggregate
//     PlayerSource via the Phase 3 adapter + the EXISTING direct-playback
//     URL policy (HTTPS-only — the same policy every provider source
//     passes), with per-stream switching through the existing quality list,
//   * end-to-end resolver → composition with injected fetch/DNS (no test
//     touches the real network; media URLs are never fetched by Mavero),
//   * the client helper (safe payload, null-source = graceful empty result),
//   * the PlaybackManager presetSource branch (skips the provider resolver
//     fetch, reuses the same validation/adapter/race machinery),
//   * the server-side availability gate (boolean only — no addon detail),
//   * source-level pins: the existing provider resolver imports NOTHING
//     from Stremio, the client never imports the Stremio resolver, and no
//     manifest URL / raw addon response can reach a PlayerSource.
// No torrent/P2P path, no HLS.js, no media proxy, no admin UI, no
// streaming_sources rows — any of those would fail these pins.

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

// ---------------------------------------------------------------------------
// Fakes + fixtures — no test ever hits the real network
// ---------------------------------------------------------------------------

const PUBLIC_IP = { address: '93.184.216.34', family: 4 } as const;
const publicResolver = async () => [PUBLIC_IP];

type RouteHandler = (init?: RequestInit) => Response;

function createFetcher(routes: Record<string, RouteHandler>, calls: Array<{ url: string; init?: RequestInit }>): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const handler = routes[url] ?? routes['*'];
    if (!handler) return new Response('not found', { status: 404 });
    return handler(init);
  }) as typeof fetch;
}

function streamsJson(streams: unknown[]): string {
  return JSON.stringify({ streams });
}

function streamRoute(streams: unknown[], status = 200): RouteHandler {
  return () => new Response(streamsJson(streams), { status, headers: { 'content-type': 'application/json' } });
}

function streamFixture(overrides: Record<string, unknown> = {}) {
  return { name: 'Example 1080p', title: 'Example 1080p', url: 'https://cdn.example/example.m3u8', ...overrides };
}

/** DB row fixture matching the Phase 1 streaming_addons shape. */
function addonRowFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Example HTTP Addon',
    slug: 'example-http-addon',
    description: null,
    manifest_url: 'https://addon.example/manifest.json',
    enabled: true,
    status: 'active',
    ordering: 1,
    logo: null,
    version: '1.0.0',
    id_property: 'imdb_id',
    supported_types: ['movie', 'series'],
    id_prefixes: ['tt'],
    resources: ['stream'],
    last_checked_at: '2026-09-10T00:00:00.000Z',
    last_success_at: '2026-09-10T00:00:00.000Z',
    last_error: null,
    capabilities: { supportsStream: true, manifestId: 'community.example', manifestVersion: '1.0.0', normalizedAt: '2026-09-10T00:00:00.000Z', streamTypes: [], streamIdPrefixes: [] },
    notes: null,
    created_at: '2026-09-10T00:00:00.000Z',
    updated_at: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

type Row = Record<string, unknown>;

/** Minimal fake Supabase client for the resolver's default addon loader. */
function fakeAddonClient(rows: Row[]) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const filters: Array<{ method: string; args: unknown[] }> = [];
  const orders: Array<{ column: string; ascending: boolean }> = [];
  const builder = {
    select(_columns: string, _options?: Record<string, unknown>) {
      calls.push({ method: 'select', args: [_columns] });
      return builder;
    },
    eq(column: string, value: unknown) {
      calls.push({ method: 'eq', args: [column, value] });
      filters.push({ method: 'eq', args: [column, value] });
      return builder;
    },
    in(column: string, values: unknown[]) {
      calls.push({ method: 'in', args: [column, values] });
      filters.push({ method: 'in', args: [column, values] });
      return builder;
    },
    order(column: string, options?: { ascending?: boolean }) {
      calls.push({ method: 'order', args: [column, options] });
      orders.push({ column, ascending: options?.ascending !== false });
      return builder;
    },
    limit(count: number) {
      calls.push({ method: 'limit', args: [count] });
      let data = [...rows];
      for (const filter of filters) {
        if (filter.method === 'eq') data = data.filter((row) => row[filter.args[0] as string] === filter.args[1]);
        else data = data.filter((row) => (filter.args[1] as unknown[]).includes(row[filter.args[0] as string]));
      }
      for (const order of [...orders].reverse()) {
        data.sort((a, b) => {
          const av = a[order.column] as string | number;
          const bv = b[order.column] as string | number;
          if (av < bv) return order.ascending ? -1 : 1;
          if (av > bv) return order.ascending ? 1 : -1;
          return 0;
        });
      }
      return Promise.resolve({ data: data.slice(0, count), error: null });
    },
    // head:true count queries (availability gate) resolve immediately.
    then(resolve: (value: { count: number; error: null }) => void) {
      const hasCountSelect = calls.some((call) => call.method === 'headCount');
      void hasCountSelect;
      return resolve({ count: rows.length, error: null });
    },
  };
  const client = {
    from(table: string) {
      calls.push({ method: 'from', args: [table] });
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, calls };
}

/** Minimal fake client for the head/count availability query. */
function fakeCountClient(result: { count?: number | null; error?: { message: string } | null }) {
  const calls: string[] = [];
  const builder = {
    select(_columns: string, options?: { count?: string; head?: boolean }) {
      calls.push(`select:${options?.count ?? ''}:${options?.head ? 'head' : 'full'}`);
      return builder;
    },
    eq(column: string, value: unknown) {
      calls.push(`eq:${column}:${String(value)}`);
      return builder;
    },
    in(column: string, values: unknown[]) {
      calls.push(`in:${column}:${values.join('|')}`);
      return builder;
    },
    then(resolve: (value: { count: number | null; error: { message: string } | null }) => void) {
      return resolve({ count: result.count ?? null, error: result.error ?? null });
    },
  };
  return { client: { from: (table: string) => { calls.push(`from:${table}`); return builder; } } as unknown as SupabaseClient<Database>, calls };
}

/** A fully-typed resolved Stremio stream fixture (Phase 3 output shape). */
function resolvedStreamFixture(overrides: Partial<StremioResolvedStream> = {}): StremioResolvedStream {
  return {
    addonId: '00000000-0000-4000-8000-000000000001',
    addonSlug: 'example-http-addon',
    addonName: 'Example HTTP Addon',
    addonOrdering: 1,
    streamIndex: 0,
    streamName: 'Example 1080p',
    streamTitle: 'Example 1080p',
    url: 'https://cdn.example/example.m3u8',
    protocol: 'hls',
    transport: 'https',
    mediaType: 'movie',
    videoId: 'tt1234567',
    idProperty: 'imdb_id',
    quality: { label: '1080p', height: 1080 },
    ...overrides,
  };
}

function resolutionFixture(sources: StremioResolvedStream[], overrides: Partial<StremioStreamResolution> = {}): StremioStreamResolution {
  return {
    mediaType: 'movie',
    requestedMediaType: 'movie',
    sources,
    unsupported: [],
    diagnostics: [],
    consideredAddons: 2,
    elapsedMs: 12,
    ...overrides,
  };
}

function makeDirectSource(overrides: Partial<PlayerSource> = {}): PlayerSource {
  return {
    type: 'direct',
    url: 'https://streams.example/video.m3u8',
    providerId: MAVERO_PLAYER_SOURCE_ID,
    sourceId: MAVERO_PLAYER_SOURCE_ID,
    mediaType: 'movie',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A. Virtual source identity + existing resolver contract isolation
// ---------------------------------------------------------------------------
{
  ok(MAVERO_PLAYER_SOURCE_ID === 'mavero-player', 'A: virtual source id is the stable mavero-player string');
  ok(MAVERO_PLAYER_SOURCE_NAME === 'MAVERO Player', 'A: virtual source display name');
  ok(isMaveroPlayerSourceId('mavero-player') === true, 'A: guard accepts the virtual id');
  ok(isMaveroPlayerSourceId('00000000-0000-4000-8000-000000000001') === false, 'A: guard rejects real source ids');
  ok(isMaveroPlayerSourceId(undefined) === false && isMaveroPlayerSourceId('') === false, 'A: guard rejects empty/undefined');

  const option = maveroPlayerSourceOption();
  ok(option.id === MAVERO_PLAYER_SOURCE_ID, 'A: option carries the virtual id');
  ok(option.name === 'MAVERO Player', 'A: option name is MAVERO Player');
  ok(option.integrationType === MAVERO_PLAYER_INTEGRATION_TYPE && option.integrationType === 'stremio', 'A: option integration marker is stremio');
  ok(option.status === 'available', 'A: option status is available');

  // The virtual id is NOT a UUID → the existing parseResolverRequest UUID
  // requirement rejects it → /api/playback/resolve contract is unchanged
  // and the virtual source can never be injected into the provider path.
  let rejected = false;
  try {
    parseResolverRequest({ sourceId: MAVERO_PLAYER_SOURCE_ID, contentId: 'movie-550', mediaType: 'movie' });
  } catch {
    rejected = true;
  }
  ok(rejected, 'A: parseResolverRequest rejects the virtual source id (UUID contract intact)');
  const parsed = parseResolverRequest({ sourceId: '00000000-0000-4000-8000-00000000000a', contentId: 'movie-550', mediaType: 'movie' });
  ok(parsed.sourceId === '00000000-0000-4000-8000-00000000000a', 'A: parseResolverRequest still accepts real UUID source ids');
}

// ---------------------------------------------------------------------------
// B. Server-side request parsing (content identifiers ONLY)
// ---------------------------------------------------------------------------
{
  const movie = parseStremioPlaybackRequest({ contentId: 'movie-550', mediaType: 'movie' });
  ok(movie.ok && movie.request.contentId === 'movie-550' && movie.request.mediaType === 'movie', 'B: valid movie request parses');
  ok(movie.ok && movie.request.season === undefined && movie.request.episode === undefined, 'B: movie request carries no season/episode');

  const series = parseStremioPlaybackRequest({ contentId: 'series-94605', mediaType: 'series', season: 2, episode: 13 });
  ok(series.ok && series.request.season === 2 && series.request.episode === 13, 'B: valid series request keeps season + episode');

  const anime = parseStremioPlaybackRequest({ contentId: 'anime-85937', mediaType: 'anime', season: 1, episode: 1 });
  ok(anime.ok && anime.request.mediaType === 'anime', 'B: valid anime request parses (server maps to Stremio series)');

  ok(!parseStremioPlaybackRequest({ contentId: 'movie-550', mediaType: 'movie', season: 1 }).ok, 'B: movie with season rejected');
  ok(!parseStremioPlaybackRequest({ contentId: 'series-94605', mediaType: 'series' }).ok, 'B: series without season/episode rejected');
  ok(!parseStremioPlaybackRequest({ contentId: 'series-94605', mediaType: 'series', season: 1 }).ok, 'B: season without episode rejected');
  ok(!parseStremioPlaybackRequest({ contentId: 'series-94605', mediaType: 'series', season: 0, episode: 1 }).ok, 'B: season 0 rejected');
  ok(!parseStremioPlaybackRequest({ contentId: 'series-94605', mediaType: 'series', season: -1, episode: 1 }).ok, 'B: negative season rejected');
  ok(!parseStremioPlaybackRequest({ contentId: 'series-94605', mediaType: 'series', season: 1.5, episode: 1 }).ok, 'B: non-integer season rejected');
  ok(!parseStremioPlaybackRequest({ contentId: 'series-94605', mediaType: 'series', season: '1', episode: 1 }).ok, 'B: string season rejected');
  ok(!parseStremioPlaybackRequest({ contentId: 'series-94605', mediaType: 'series', season: 10001, episode: 1 }).ok, 'B: out-of-range season rejected');
  ok(!parseStremioPlaybackRequest({ contentId: '../escape', mediaType: 'movie' }).ok, 'B: path-traversal contentId rejected');
  ok(!parseStremioPlaybackRequest({ contentId: '', mediaType: 'movie' }).ok, 'B: empty contentId rejected');
  ok(!parseStremioPlaybackRequest({ contentId: 'movie-550', mediaType: 'tv' }).ok, 'B: unknown mediaType rejected');
  const stripped = parseStremioPlaybackRequest({ contentId: 'movie-550', mediaType: 'movie', manifestUrl: 'https://evil.example/manifest.json' });
  ok(stripped.ok && !('manifestUrl' in (stripped.ok ? stripped.request : {})), 'B: extraneous client fields (e.g. manifestUrl) are stripped — never honored');

  // The client cannot inject addon ids or manifest URLs into resolution —
  // addon configuration is loaded server-side from the database.
  ok(!parseStremioPlaybackRequest(null).ok, 'B: null body rejected');
  ok(!parseStremioPlaybackRequest('movie-550').ok, 'B: string body rejected');
  ok(!parseStremioPlaybackRequest(['movie-550']).ok, 'B: array body rejected');
  ok(!parseStremioPlaybackRequest({}).ok, 'B: body without identifiers rejected');
}

// ---------------------------------------------------------------------------
// C. Composition — resolver output → ONE aggregate PlayerSource
// ---------------------------------------------------------------------------
{
  const source = maveroPlayerSourceFromResolution(resolutionFixture([resolvedStreamFixture()]));
  ok(source !== null, 'C: single stream composes an aggregate source');
  if (source) {
    ok(source.type === 'direct', 'C: composed type is direct (existing direct-player path)');
    ok(source.sourceId === MAVERO_PLAYER_SOURCE_ID && source.providerId === MAVERO_PLAYER_SOURCE_ID, 'C: composed identity is the stable virtual id (no fake uuids)');
    ok(source.url === 'https://cdn.example/example.m3u8', 'C: aggregate url is the deterministic first stream');
    ok(source.mediaType === 'movie', 'C: media type carried from the Stremio mapping');
    ok(Array.isArray(source.qualities) && source.qualities?.length === 1, 'C: one stream → one quality entry');
    ok(source.qualities?.[0]?.url === source.url, 'C: the primary stream is qualities[0] (consistent default)');
    ok((source.qualities?.[0]?.label ?? '').includes('Example HTTP Addon') && (source.qualities?.[0]?.label ?? '').includes('1080p'), 'C: quality label carries addon name + quality');
    ok(source.qualities?.[0]?.height === 1080, 'C: quality height carried');
    ok(source.metadata?.sourceName === 'MAVERO Player' && source.metadata?.providerName === 'MAVERO Player', 'C: metadata names the virtual source');
    ok(source.metadata?.protocol === 'hls', 'C: protocol carried from the primary stream');
    ok((source.metadata?.note ?? '').includes('MAVERO Player'), 'C: aggregate note identifies MAVERO Player');
    ok(isPlayablePlayerSource(source), 'C: composed source passes the existing playability guard');
    const keys = Object.keys(source).sort().join(',');
    ok(keys === 'mediaType,metadata,providerId,qualities,sourceId,type,url', 'C: composed source carries ONLY PlayerSource fields');
    ok(!('expiresAt' in source) && !('headers' in source) && !('sandboxPolicy' in source), 'C: no headers/sandbox/expiry invented for addon streams');
  }
}

// ---------------------------------------------------------------------------
// D. Multiple streams → existing quality list (no source-sheet redesign)
// ---------------------------------------------------------------------------
{
  const sources = [
    resolvedStreamFixture({ addonSlug: 'addon-a', addonName: 'Addon A', addonOrdering: 1, streamIndex: 0, url: 'https://a.example/1080.m3u8', quality: { label: '1080p', height: 1080 } }),
    resolvedStreamFixture({ addonSlug: 'addon-a', addonName: 'Addon A', addonOrdering: 1, streamIndex: 1, url: 'https://a.example/720.m3u8', quality: { label: '720p', height: 720 } }),
    resolvedStreamFixture({ addonId: '00000000-0000-4000-8000-000000000002', addonSlug: 'addon-b', addonName: 'Addon B', addonOrdering: 2, streamIndex: 0, url: 'https://b.example/auto.mp4', protocol: 'mp4', quality: { label: 'Auto' } }),
  ];
  const source = maveroPlayerSourceFromResolution(resolutionFixture(sources));
  ok(source?.qualities?.length === 3, 'D: every resolved stream becomes one selectable entry');
  const urls = (source?.qualities ?? []).map((quality) => quality.url);
  ok(new Set(urls).size === 3, 'D: quality urls are unique');
  ok(source?.url === 'https://a.example/1080.m3u8', 'D: deterministic first stream is the aggregate url (resolver order)');
  // Phase 9: fair round-robin aggregation interleaves addon buckets — pass 1
  // takes A[0] + B[0], pass 2 takes A[1]. B's entry moved from index 2 to 1.
  ok((source?.qualities?.[1]?.label ?? '').startsWith('Addon B ·'), 'D: labels distinguish addons (round-robin interleaves buckets)');
  ok(source?.qualities?.[1]?.height === undefined, 'D: Auto quality carries no fabricated height');
  ok((source?.qualities?.[2]?.label ?? '').startsWith('Addon A ·'), 'D: the first addon\u2019s second stream follows in pass 2');
  ok((source?.metadata?.note ?? '').includes('3 addon streams'), 'D: aggregate note counts the streams');
}

// ---------------------------------------------------------------------------
// E. Existing HTTPS-only direct-playback policy is enforced at the boundary
// ---------------------------------------------------------------------------
{
  const sources = [
    resolvedStreamFixture({ url: 'http://insecure.example/video.m3u8', transport: 'http', streamIndex: 0 }),
    resolvedStreamFixture({ url: 'http://127.0.0.1:8080/video.m3u8', transport: 'http', streamIndex: 1 }),
    resolvedStreamFixture({ url: 'https://secure.example/video.m3u8', streamIndex: 2 }),
  ];
  ok((() => { try { validatePlaybackUrl('http://insecure.example/video.m3u8', 'direct'); return false; } catch { return true; } })(), 'E: existing policy rejects plain-http direct urls (unchanged)');
  const source = maveroPlayerSourceFromResolution(resolutionFixture(sources));
  ok(source !== null && source.qualities?.length === 1, 'E: only https streams survive the existing playback boundary');
  ok(source?.url === 'https://secure.example/video.m3u8', 'E: primary skips excluded streams to the first https stream');
  const allHttp = maveroPlayerSourceFromResolution(resolutionFixture(sources.slice(0, 2)));
  ok(allHttp === null, 'E: all-excluded resolution composes NOTHING (graceful empty result)');
}

// ---------------------------------------------------------------------------
// F/G. Empty + failure semantics — never an error that breaks the player
// ---------------------------------------------------------------------------
{
  ok(maveroPlayerSourceFromResolution(resolutionFixture([])) === null, 'F: zero resolved streams → null (graceful "no playable streams")');

  // Partial addon failure: diagnostics record failures, successful streams
  // still compose (Phase 3 isolation + Phase 4 composition).
  const partial = resolutionFixture([resolvedStreamFixture({ addonSlug: 'healthy' })], {
    diagnostics: [
      { addonId: '00000000-0000-4000-8000-000000000001', addonName: 'Healthy', addonOrdering: 1, status: 'ok', streamCount: 1, unsupportedCount: 0 },
      { addonId: '00000000-0000-4000-8000-000000000002', addonName: 'Broken', addonOrdering: 2, status: 'failed', errorCode: 'HTTP_ERROR' },
    ],
    consideredAddons: 2,
  });
  const partialSource = maveroPlayerSourceFromResolution(partial);
  ok(partialSource !== null && partialSource.qualities?.length === 1, 'G: one failed addon never blocks the healthy addon stream');
}

// ---------------------------------------------------------------------------
// H. Deterministic payload cap (Phase 9: fair per-addon + total budgets)
// ---------------------------------------------------------------------------
{
  ok(MAVERO_PLAYER_MAX_STREAMS === 100, 'H: total response cap constant pinned (Phase 9)');
  ok(MAVERO_PLAYER_STREAMS_PER_ADDON === 40, 'H: per-addon cap constant pinned (Phase 9 — no single addon can consume the aggregate)');
  const many = Array.from({ length: 30 }, (_, index) => resolvedStreamFixture({ streamIndex: index, url: `https://cdn.example/stream-${index}.m3u8`, quality: { label: 'Auto' } }));
  const source = maveroPlayerSourceFromResolution(resolutionFixture(many));
  ok(source?.qualities?.length === 30, 'H: a single addon under the per-addon budget keeps ALL of its streams (order preserved)');
  ok(source?.qualities?.[0]?.url === 'https://cdn.example/stream-0.m3u8', 'H: first (deterministic) entry unchanged');
  ok(source?.qualities?.[29]?.url === 'https://cdn.example/stream-29.m3u8', 'H: order inside one addon is the resolver order');
  const excess = Array.from({ length: 55 }, (_, index) => resolvedStreamFixture({ streamIndex: index, url: `https://cdn.example/over-${index}.m3u8`, quality: { label: 'Auto' } }));
  const capped = maveroPlayerSourceFromResolution(resolutionFixture(excess));
  ok(capped?.qualities?.length === MAVERO_PLAYER_STREAMS_PER_ADDON, 'H: one addon can never contribute more than the per-addon budget');
}

// ---------------------------------------------------------------------------
// I. Anime uses the Phase 3 mapping (no fabricated types)
// ---------------------------------------------------------------------------
{
  const source = maveroPlayerSourceFromResolution(
    resolutionFixture([resolvedStreamFixture({ mediaType: 'series', videoId: 'tt1234567:1:1' })], { mediaType: 'series', requestedMediaType: 'anime' }),
  );
  ok(source?.mediaType === 'series', 'I: anime content plays through the Phase 3 anime→series mapping (Stremio series type)');
}

// ---------------------------------------------------------------------------
// J. End-to-end: Phase 3 resolver (injected fetch/DNS) → composition
// ---------------------------------------------------------------------------
{
  // Movie — identifiers flow from the EXISTING normalization output.
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = createFetcher({ 'https://addon.example/stream/movie/tt1234567.json': streamRoute([streamFixture(), streamFixture({ url: 'https://cdn.example/movie.mp4', name: 'Example 2160p', title: 'Example 2160p' })]) }, calls);
  const { client } = fakeAddonClient([addonRowFixture()]);
  const resolution = await resolveStremioStreams(
    client,
    { mediaType: 'movie', identifiers: { imdbId: 'tt1234567', tmdbId: '12345' } },
    { fetcher, dnsResolver: publicResolver },
  );
  ok(calls.length === 1 && calls[0].url === 'https://addon.example/stream/movie/tt1234567.json', 'J: resolver invoked with the constructed movie endpoint');
  const movieSource = maveroPlayerSourceFromResolution(resolution, 'Example Movie');
  ok(movieSource !== null && movieSource.qualities?.length === 1, 'J: movie resolution composes the HLS stream (the MP4 direct file is isolated to the Mavero Downloader — Phase 14)');
  ok(!JSON.stringify(movieSource).includes('movie.mp4'), 'J: the isolated direct-file URL never reaches the player payload');
  ok(movieSource?.metadata?.title === 'Example Movie', 'J: aggregate title is the content title');
  ok(!JSON.stringify(movieSource).includes('addon.example'), 'J: the manifest URL NEVER appears in the composed source');
  ok(!JSON.stringify(movieSource).includes('manifest'), 'J: no manifest reference of any kind in the payload');

  // Series — season/episode flow server-side into the Stremio video id.
  const seriesCalls: Array<{ url: string; init?: RequestInit }> = [];
  const seriesFetcher = createFetcher({ 'https://addon.example/stream/series/tt1234567:2:13.json': streamRoute([streamFixture()]) }, seriesCalls);
  const { client: seriesClient } = fakeAddonClient([addonRowFixture()]);
  const seriesResolution = await resolveStremioStreams(
    seriesClient,
    { mediaType: 'series', identifiers: { imdbId: 'tt1234567', tmdbId: '12345' }, season: 2, episode: 13 },
    { fetcher: seriesFetcher, dnsResolver: publicResolver },
  );
  ok(seriesCalls[0].url === 'https://addon.example/stream/series/tt1234567:2:13.json', 'J: series season/episode reach the resolver (constructed video id)');
  const seriesSource = maveroPlayerSourceFromResolution(seriesResolution);
  ok(seriesSource !== null && seriesSource.mediaType === 'series', 'J: series resolution composes with the series media type');

  // All addons fail → empty resolution → null (graceful; the route shows the
  // "no playable streams" state and existing provider sources remain).
  const failingFetcher = createFetcher({ '*': () => new Response('boom', { status: 500 }) }, []);
  const { client: failingClient } = fakeAddonClient([addonRowFixture()]);
  const emptyResolution = await resolveStremioStreams(
    failingClient,
    { mediaType: 'movie', identifiers: { imdbId: 'tt1234567', tmdbId: '12345' } },
    { fetcher: failingFetcher, dnsResolver: publicResolver },
  );
  ok(emptyResolution.sources.length === 0, 'J: all-addons-fail yields an empty (not thrown) resolution');
  ok(maveroPlayerSourceFromResolution(emptyResolution) === null, 'J: empty resolution composes null → graceful player state');
}

// ---------------------------------------------------------------------------
// K. Client helper — safe payload + graceful empty/failure results
// ---------------------------------------------------------------------------
{
  const okSource = makeDirectSource();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = createFetcher({ '/api/playback/stremio': () => new Response(JSON.stringify({ ok: true, source: okSource }), { status: 200, headers: { 'content-type': 'application/json' } }) }, calls);
  const signal = new AbortController().signal;
  const result = await resolveMaveroPlayerSource({ contentId: 'movie-550', mediaType: 'movie' }, { fetcher, signal });
  ok(result.ok && result.source.sourceId === okSource.sourceId && result.source.url === okSource.url && result.source.type === 'direct', 'K: successful resolution returns the source (value-equal after the payload round-trip)');
  ok(calls.length === 1 && calls[0].url === '/api/playback/stremio', 'K: the helper talks ONLY to the dedicated endpoint');
  ok(calls[0].init?.method === 'POST', 'K: POST request');
  const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
  ok(body.contentId === 'movie-550' && body.mediaType === 'movie', 'K: movie payload carries content identifiers');
  ok(!('season' in body) && !('episode' in body), 'K: movie payload carries no season/episode');
  ok((calls[0].init?.signal ?? null) === signal, 'K: abort signal forwarded');

  const seriesCalls: Array<{ url: string; init?: RequestInit }> = [];
  const seriesFetcher = createFetcher({ '/api/playback/stremio': () => new Response(JSON.stringify({ ok: true, source: okSource }), { status: 200 }) }, seriesCalls);
  await resolveMaveroPlayerSource({ contentId: 'series-94605', mediaType: 'series', season: 2, episode: 13 }, { fetcher: seriesFetcher });
  const seriesBody = JSON.parse(String(seriesCalls[0].init?.body)) as Record<string, unknown>;
  ok(seriesBody.season === 2 && seriesBody.episode === 13, 'K: series payload carries season + episode');

  const animeCalls: Array<{ url: string; init?: RequestInit }> = [];
  const animeFetcher = createFetcher({ '/api/playback/stremio': () => new Response(JSON.stringify({ ok: true, source: okSource }), { status: 200 }) }, animeCalls);
  await resolveMaveroPlayerSource({ contentId: 'anime-85937', mediaType: 'anime', season: 1, episode: 1 }, { fetcher: animeFetcher });
  const animeBody = JSON.parse(String(animeCalls[0].init?.body)) as Record<string, unknown>;
  ok(animeBody.mediaType === 'anime' && animeBody.season === 1 && animeBody.episode === 1, 'K: anime payload passes through server-side for mapping');

  const empty = await resolveMaveroPlayerSource({ contentId: 'movie-550', mediaType: 'movie' }, { fetcher: createFetcher({ '*': () => new Response(JSON.stringify({ ok: true, source: null }), { status: 200 }) }, []) });
  ok(!empty.ok && empty.code === 'NO_STREAMS' && empty.message.includes('No playable streams'), 'K: null source → graceful NO_STREAMS (not an exception)');

  const httpSource = await resolveMaveroPlayerSource({ contentId: 'movie-550', mediaType: 'movie' }, {
    fetcher: createFetcher({ '*': () => new Response(JSON.stringify({ ok: true, source: makeDirectSource({ url: 'http://insecure.example/x.m3u8' }) }), { status: 200 }) }, []),
  });
  ok(!httpSource.ok && httpSource.code === 'NO_STREAMS', 'K: a source failing the existing playability guard is never loaded');

  const invalid = await resolveMaveroPlayerSource({ contentId: 'movie-550', mediaType: 'movie' }, {
    fetcher: createFetcher({ '*': () => new Response(JSON.stringify({ ok: false, error: { code: 'INVALID_REQUEST', message: 'The MAVERO Player request is invalid.' } }), { status: 400 }) }, []),
  });
  ok(!invalid.ok && invalid.code === 'INVALID_REQUEST', 'K: server validation errors surface with their code');

  const network = await resolveMaveroPlayerSource({ contentId: 'movie-550', mediaType: 'movie' }, { fetcher: (async () => { throw new Error('down'); }) as typeof fetch });
  ok(!network.ok && network.code === 'NETWORK', 'K: transport failure → NETWORK (existing sources stay switchable)');

  const malformed = await resolveMaveroPlayerSource({ contentId: 'movie-550', mediaType: 'movie' }, { fetcher: createFetcher({ '*': () => new Response('not json', { status: 200 }) }, []) });
  ok(!malformed.ok && malformed.code === 'NETWORK', 'K: malformed JSON → NETWORK');

  const leaking = await resolveMaveroPlayerSource({ contentId: 'movie-550', mediaType: 'movie' }, {
    fetcher: createFetcher({ '*': () => new Response(JSON.stringify({ ok: true, source: { ...okSource, metadata: { ...okSource.metadata, note: 'manifest https://addon.example/manifest.json' } } }), { status: 200 }) }, []),
  });
  ok(leaking.ok, 'K: helper returns whatever the trusted server endpoint normalized (server-side responsibility)');
}

// ---------------------------------------------------------------------------
// L. PlaybackManager presetSource branch (MAVERO Player → existing player)
// ---------------------------------------------------------------------------
{
  // L1: preset direct source loads through the direct adapter WITHOUT any
  // resolver fetch — the provider resolver is never contacted.
  let fetchCalled = false;
  const manager = new PlaybackManager({ fetcher: (async (...args: Parameters<typeof fetch>) => { fetchCalled = true; return fetch(...args); }) as typeof fetch });
  const states: string[] = [];
  const unsubscribe = manager.subscribe((snapshot) => states.push(snapshot.resolutionState));
  await manager.loadSource(
    { sourceId: MAVERO_PLAYER_SOURCE_ID, contentId: 'movie-550', mediaType: 'movie', presetSource: makeDirectSource() },
    42,
    false,
  );
  ok(fetchCalled === false, 'L: presetSource skips /api/playback/resolve entirely');
  ok(manager.getState().resolutionState === 'ready', 'L: preset source reaches ready');
  ok(manager.getState().source?.sourceId === MAVERO_PLAYER_SOURCE_ID, 'L: loaded source keeps the virtual identity');
  ok(manager.getState().source?.type === 'direct', 'L: preset source loads as direct');
  ok(manager.getState().pendingSeek === 42, 'L: start position carried into the session (resume works)');
  const capabilities = manager.getActiveCapabilities();
  ok(capabilities.currentTime === true && capabilities.seek === true, 'L: direct adapter capabilities (native player commands)');
  ok(JSON.stringify(capabilities) === JSON.stringify(DIRECT_PLAYBACK_CAPABILITIES), 'L: DIRECT capabilities unchanged');
  ok(states.includes('resolving') && states[states.length - 1] === 'ready', 'L: session passes through resolving → ready (loading UX)');
  unsubscribe();
  manager.dispose();

  // L2: preset EMBED source still takes the existing embed path unchanged.
  const embedManager = new PlaybackManager({ fetcher: (async () => { throw new Error('must not fetch'); }) as typeof fetch });
  await embedManager.loadSource(
    { sourceId: '00000000-0000-4000-8000-00000000000b', contentId: 'movie-550', mediaType: 'movie', presetSource: { type: 'embed', url: 'https://provider.example/embed/550', providerId: '00000000-0000-4000-8000-00000000000c', sourceId: '00000000-0000-4000-8000-00000000000d', mediaType: 'movie' } },
    0,
    false,
  );
  ok(embedManager.getState().resolutionState === 'ready' && embedManager.getState().source?.type === 'embed', 'L: preset embed source uses the embed path');
  ok(JSON.stringify(embedManager.getActiveCapabilities()) === JSON.stringify(EMBED_PLAYBACK_CAPABILITIES), 'L: embed capabilities unchanged');
  embedManager.dispose();

  // L3: a preset source that fails manager validation → unavailable state,
  // no crash, provider sources untouched.
  const brokenManager = new PlaybackManager({ fetcher: (async () => { throw new Error('must not fetch'); }) as typeof fetch });
  await brokenManager.loadSource(
    { sourceId: MAVERO_PLAYER_SOURCE_ID, contentId: 'movie-550', mediaType: 'movie', presetSource: { type: 'direct', url: '', providerId: MAVERO_PLAYER_SOURCE_ID, sourceId: MAVERO_PLAYER_SOURCE_ID, mediaType: 'movie' } as PlayerSource },
    0,
    false,
  );
  ok(brokenManager.getState().resolutionState === 'unavailable', 'L: invalid preset source → unavailable state (graceful)');
  brokenManager.dispose();

  // L4: a preset source with a plain-http url cannot PLAY (existing guard):
  // the session reports source-unavailable instead of loading insecure media.
  const httpManager = new PlaybackManager({ fetcher: (async () => { throw new Error('must not fetch'); }) as typeof fetch });
  await httpManager.loadSource(
    { sourceId: MAVERO_PLAYER_SOURCE_ID, contentId: 'movie-550', mediaType: 'movie', presetSource: makeDirectSource({ url: 'http://insecure.example/x.m3u8' }) },
    0,
    false,
  );
  ok(httpManager.getState().state === 'source-unavailable', 'L: http preset source is gated by the existing playability guard');
  httpManager.dispose();

  // L5: rapid preset switches — the newest selection wins, no stale source
  // overwrite (existing race machinery reused).
  const raceManager = new PlaybackManager({ fetcher: (async () => { throw new Error('must not fetch'); }) as typeof fetch });
  await raceManager.loadSource({ sourceId: MAVERO_PLAYER_SOURCE_ID, contentId: 'movie-550', mediaType: 'movie', presetSource: makeDirectSource({ url: 'https://streams.example/a.m3u8' }) }, 0, false);
  await raceManager.loadSource({ sourceId: MAVERO_PLAYER_SOURCE_ID, contentId: 'movie-550', mediaType: 'movie', presetSource: makeDirectSource({ url: 'https://streams.example/b.m3u8' }) }, 0, false);
  ok(raceManager.getState().source?.url === 'https://streams.example/b.m3u8', 'L: rapid source switches resolve to the newest source');
  raceManager.dispose();

  // L6: the EXISTING provider path is byte-for-byte unchanged in behavior:
  // without presetSource the manager still POSTs /api/playback/resolve.
  const providerCalls: Array<{ url: string; init?: RequestInit }> = [];
  const providerManager = new PlaybackManager({
    fetcher: createFetcher({ '/api/playback/resolve': () => new Response(JSON.stringify({ ok: true, source: { type: 'embed', url: 'https://vidsrc.example/e/550', providerId: '00000000-0000-4000-8000-00000000000e', sourceId: '00000000-0000-4000-8000-00000000000f', mediaType: 'movie' } }), { status: 200, headers: { 'content-type': 'application/json' } }) }, providerCalls),
  });
  await providerManager.loadSource({ sourceId: '00000000-0000-4000-8000-000000000001', contentId: 'movie-550', mediaType: 'movie' }, 0, true);
  ok(providerCalls.length === 1 && providerCalls[0].url === '/api/playback/resolve', 'L: provider sources still resolve via /api/playback/resolve');
  const providerBody = JSON.parse(String(providerCalls[0].init?.body)) as Record<string, unknown>;
  ok(providerBody.sourceId === '00000000-0000-4000-8000-000000000001' && providerBody.enableFallback === true, 'L: provider resolver request contract unchanged');
  providerManager.dispose();
}

// ---------------------------------------------------------------------------
// M. Availability gate (server-side boolean; no addon detail leaks)
// ---------------------------------------------------------------------------
{
  const available = fakeCountClient({ count: 2 });
  ok(await hasStreamEligibleAddons(available.client) === true, 'M: eligible addons → true');
  ok(available.calls.includes('from:streaming_addons'), 'M: queries the streaming_addons table');
  ok(available.calls.includes('eq:enabled:true'), 'M: only ENABLED addons count');
  ok(available.calls.includes('in:status:active|experimental'), 'M: status policy matches the resolver (active/experimental)');
  ok(available.calls.includes('eq:capabilities->>supportsStream:true'), 'M: explicit stream capability required (fail-closed)');
  ok(available.calls.some((call) => call.startsWith('select:') && call.endsWith('head')), 'M: count-only head query (no addon rows leave the server)');

  ok(await hasStreamEligibleAddons(fakeCountClient({ count: 0 }).client) === false, 'M: zero eligible addons → false (option hidden, providers unchanged)');
  ok(await hasStreamEligibleAddons(fakeCountClient({ count: null }).client) === false, 'M: null count → false');
  await assert.rejects(
    () => hasStreamEligibleAddons(fakeCountClient({ error: { message: 'db down' } }).client),
    () => true,
    'M: lookup failures throw (the watch page degrades to false — providers only)',
  );
}

// ---------------------------------------------------------------------------
// N. Source-level pins — architectural boundaries
// ---------------------------------------------------------------------------
{
  const resolveRoute = readFileSync('src/routes/api/playback/resolve/+server.ts', 'utf8');
  ok(!/stremio/i.test(resolveRoute), 'N: existing /api/playback/resolve route imports NOTHING from Stremio');

  const service = readFileSync('src/lib/server/resolver/service.ts', 'utf8');
  const core = readFileSync('src/lib/server/resolver/core.ts', 'utf8');
  const adapters = readFileSync('src/lib/server/resolver/adapters.ts', 'utf8');
  ok(!/stremio/i.test(service) && !/stremio/i.test(core) && !/stremio/i.test(adapters), 'N: the provider resolver never imports the Stremio resolver');

  const stremioRoute = readFileSync('src/routes/api/playback/stremio/+server.ts', 'utf8');
  ok(stremioRoute.includes('resolveStremioStreams'), 'N: the dedicated endpoint invokes the Phase 3 resolver');
  ok(stremioRoute.includes('maveroPlayerSourceFromResolution') && stremioRoute.includes('parseStremioPlaybackRequest'), 'N: the endpoint composes via the Phase 4 module');
  ok(stremioRoute.includes('createSupabaseAdminClient'), 'N: addon configuration is loaded server-side (service role — no anon addon reads)');
  ok(!/manifestUrl|manifest_url|unsupported|diagnostics|bingeGroup|videoSize|filename/.test(stremioRoute), 'N: the endpoint never references raw addon response fields');

  const managerSource = readFileSync('src/lib/client/player/PlaybackManager.ts', 'utf8');
  ok(!/from\s+'[^']*stremio/i.test(managerSource), 'N: the client player NEVER imports Stremio modules (server/client boundary)');
  ok(!managerSource.includes('$lib/server'), 'N: the client player imports NO server modules');
  ok(managerSource.includes('presetSource'), 'N: the manager exposes the additive presetSource branch');

  const sharedModule = readFileSync('src/lib/shared/mavero-player.ts', 'utf8');
  ok(!sharedModule.includes('$lib/server'), 'N: the shared identity module stays client-safe');

  const clientHelper = readFileSync('src/lib/client/player/mavero-player.ts', 'utf8');
  ok(clientHelper.includes("'/api/playback/stremio'"), 'N: the client helper targets the dedicated endpoint');
  ok(!/stremio\/(stream|manifest)-/.test(clientHelper), 'N: the client helper imports no server Stremio modules');

  const watchPage = readFileSync('src/routes/watch/[type]/[id]/+page.svelte', 'utf8');
  ok(watchPage.includes('maveroPlayerSourceOption()'), 'N: the watch route appends the virtual option');
  ok(watchPage.includes('data.maveroPlayerAvailable'), 'N: the virtual option is server-gated');
  ok(watchPage.includes('isMaveroPlayerSourceId(sourceId)'), 'N: the route branches to the MAVERO Player path by identity');
  ok(watchPage.includes('prepareMaveroPlayerSource'), 'N: the route implements the MAVERO Player resolution branch');
  // Phase 10: the aggregate source loads through the manager from the
  // PROGRESSIVELY MERGED result (first playable stream → live merges) —
  // same presetSource mechanism, now fed by mergeMaveroResults.
  ok(watchPage.includes('presetSource: merged'), 'N: the resolved aggregate source loads through the manager (Phase 10: progressively merged)');

  const watchServer = readFileSync('src/routes/watch/[type]/[id]/+page.server.ts', 'utf8');
  ok(watchServer.includes('hasStreamEligibleAddons'), 'N: availability is decided server-side');

  const composition = readFileSync('src/lib/server/streaming/stremio/mavero-player-source.ts', 'utf8');
  ok(composition.includes('stremioStreamToPlayerSource'), 'N: composition uses the Phase 3 adapter (no second representation)');
  ok(composition.includes("validatePlaybackUrl(source.url, 'direct')"), 'N: composition enforces the existing direct-playback URL policy');

  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: { test: string } };
  ok(packageJson.scripts.test.includes('stremio_player_phase4_test.ts'), 'N: Phase 4 tests are in the repository test chain');
}

console.log(`stremio_player_phase4_test: ${passed} checks passed`);
