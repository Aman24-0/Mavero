import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { resolveStremioStreams, STREAM_RESOLUTION_CONCURRENCY, STREAM_RESOLUTION_TIMEOUT_MS, type StremioStreamResolution } from '$lib/server/streaming/stremio/stream-resolver';
import { stremioStreamToPlayerSource, stremioSourceId } from '$lib/server/streaming/stremio/stream-player-source';
import { buildStremioStreamUrl, planAddonStreamRequest, resolveAddonIdProperty, stremioStreamTypeFor } from '$lib/server/streaming/stremio/stream-ids';
import { normalizeStremioStreamResponse, type NormalizedStremioStream } from '$lib/server/streaming/stremio/stream-normalize';
import { fetchStremioStreamResponse, STREAM_MAX_BYTES, STREAM_REQUEST_TIMEOUT_MS } from '$lib/server/streaming/stremio/stream-fetch';
import { StreamServiceError } from '$lib/server/streaming/stremio/stream-errors';
import { mapAddonRow } from '$lib/server/streaming/addons';
import { protocolForUrl, validatePlaybackUrl } from '$lib/server/resolver/safe-url';
import { parseResolverRequest } from '$lib/server/resolver/identifiers';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { createDefaultAdapters } from '$lib/server/resolver/adapters';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { ContentIdentifiers } from '$lib/server/resolver/types';

// Phase 3: secure Stremio HTTP stream RESOLVER contract tests.
//
// Scope: server-side /stream/{type}/{id}.json resolution — addon eligibility
// (explicit stream capability, media type, idProperty/idPrefixes), video ID
// construction, bounded parallel fetching with per-addon failure isolation,
// HTTP/HLS-only stream normalization (torrent/externalUrl/proxy-header
// rejection), deduplication, deterministic ordering, and the PlayerSource
// adapter. NO native playback, NO player changes, NO torrent/P2P, NO
// endpoint. No test touches the real internet: fetch and DNS are always
// injected fakes; stream MEDIA URLs are never fetched by Mavero.

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

// ---------------------------------------------------------------------------
// Fakes — no test ever hits the real network
// ---------------------------------------------------------------------------

const PUBLIC_IP = { address: '93.184.216.34', family: 4 } as const;
const publicResolver = async () => [PUBLIC_IP];

type RouteHandler = (init?: RequestInit) => Response;

function jsonRoute(body: string, status = 200, headers: Record<string, string> = {}): RouteHandler {
  return () => new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
}

function createFetcher(routes: Record<string, RouteHandler>, calls: Array<{ url: string; signal: AbortSignal | null }>): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, signal: init?.signal ?? null });
    const handler = routes[url] ?? routes['*'];
    if (!handler) return new Response('not found', { status: 404 });
    return handler(init);
  }) as typeof fetch;
}

function streamsJson(streams: unknown[]): string {
  return JSON.stringify({ streams });
}

function streamRoute(streams: unknown[], status = 200): RouteHandler {
  return jsonRoute(streamsJson(streams), status);
}

function streamFixture(overrides: Record<string, unknown> = {}) {
  return { name: 'Example 1080p', title: 'Example 1080p', url: 'https://cdn.example/example.m3u8', ...overrides };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function spinUntil(condition: () => boolean, maxSpins = 1000): Promise<void> {
  for (let spin = 0; spin < maxSpins; spin += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(condition(), 'condition not reached within the spin budget');
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

/**
 * Fake Supabase client for the default addon loader. Mimics the DB: `.eq`
 * and `.in` filters are applied to the fixture rows, `.order` sorts, and
 * `.limit` resolves — while recording the exact query contract.
 */
function fakeAddonClient(rows: Row[]) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const filters: Array<{ method: string; args: unknown[] }> = [];
  const orders: Array<{ column: string; ascending: boolean }> = [];
  const builder = {
    select(_columns: string) {
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
  };
  const client = {
    from(table: string) {
      calls.push({ method: 'from', args: [table] });
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, calls };
}

const identifiers: Pick<ContentIdentifiers, 'imdbId' | 'tmdbId'> = { imdbId: 'tt1234567', tmdbId: '12345' };
const movieRequest = { mediaType: 'movie' as const, identifiers };
const seriesRequest = { mediaType: 'series' as const, identifiers, season: 1, episode: 1 };

function diagnosticFor(resolution: StremioStreamResolution, addonId: string) {
  return resolution.diagnostics.find((entry) => entry.addonId === addonId);
}

function skippedWith(resolution: StremioStreamResolution, addonId: string, reason: string): boolean {
  const diagnostic = diagnosticFor(resolution, addonId);
  return diagnostic?.status === 'skipped' && diagnostic.reason === reason;
}

function failedWith(resolution: StremioStreamResolution, addonId: string, errorCode: string): boolean {
  const diagnostic = diagnosticFor(resolution, addonId);
  return diagnostic?.status === 'failed' && diagnostic.errorCode === errorCode;
}

// ---------------------------------------------------------------------------
// A. Movie request with an IMDb id
// ---------------------------------------------------------------------------
{
  const calls: Array<{ url: string; signal: AbortSignal | null }> = [];
  const fetcher = createFetcher({ 'https://addon.example/stream/movie/tt1234567.json': streamRoute([streamFixture()]) }, calls);
  const { client } = fakeAddonClient([addonRowFixture()]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  ok(resolution.sources.length === 1, 'A: movie IMDb resolution returns one source');
  ok(resolution.sources[0].url === 'https://cdn.example/example.m3u8', 'A: stream URL preserved');
  ok(resolution.sources[0].videoId === 'tt1234567', 'A: video id is the IMDb id');
  ok(resolution.sources[0].idProperty === 'imdb_id', 'A: idProperty retained');
  ok(resolution.mediaType === 'movie' && resolution.sources[0].mediaType === 'movie', 'A: media type mapped');
  ok(calls.length === 1 && calls[0].url === 'https://addon.example/stream/movie/tt1234567.json', 'A: exactly one request to the constructed endpoint');
}

// ---------------------------------------------------------------------------
// B. Series request with an IMDb id (season 1, episode 1)
// ---------------------------------------------------------------------------
{
  const calls: Array<{ url: string; signal: AbortSignal | null }> = [];
  const fetcher = createFetcher({ 'https://addon.example/stream/series/tt1234567:1:1.json': streamRoute([streamFixture()]) }, calls);
  const { client } = fakeAddonClient([addonRowFixture()]);
  const resolution = await resolveStremioStreams(client, seriesRequest, { fetcher, dnsResolver: publicResolver });
  ok(resolution.sources.length === 1, 'B: series resolution returns one source');
  ok(resolution.sources[0].videoId === 'tt1234567:1:1', 'B: series video id is <base>:<season>:<episode>');
  ok(calls[0].url === 'https://addon.example/stream/series/tt1234567:1:1.json', 'B: series endpoint constructed correctly');
}

// ---------------------------------------------------------------------------
// C. Series season > 1 and episode > 1
// ---------------------------------------------------------------------------
{
  const calls: Array<{ url: string; signal: AbortSignal | null }> = [];
  const fetcher = createFetcher({ 'https://addon.example/stream/series/tt1234567:2:13.json': streamRoute([streamFixture()]) }, calls);
  const { client } = fakeAddonClient([addonRowFixture()]);
  const resolution = await resolveStremioStreams(client, { ...seriesRequest, season: 2, episode: 13 }, { fetcher, dnsResolver: publicResolver });
  ok(resolution.sources[0].videoId === 'tt1234567:2:13', 'C: season/episode appended in protocol order');
  ok(calls[0].url === 'https://addon.example/stream/series/tt1234567:2:13.json', 'C: endpoint uses the exact episode video id');
}

// ---------------------------------------------------------------------------
// D. idProperty handling — declared, unsupported, and defaulted
// ---------------------------------------------------------------------------
{
  // Declared tmdb_id → documented `tmdb:{id}` Stremio ID format.
  const calls: Array<{ url: string; signal: AbortSignal | null }> = [];
  const fetcher = createFetcher({ 'https://tmdb-addon.example/stream/movie/tmdb:12345.json': streamRoute([streamFixture()]) }, calls);
  const { client } = fakeAddonClient([addonRowFixture({ id: '00000000-0000-4000-8000-0000000000d1', slug: 'tmdb-addon', manifest_url: 'https://tmdb-addon.example/manifest.json', id_property: 'tmdb_id', id_prefixes: ['tmdb'] })]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  ok(resolution.sources.length === 1 && resolution.sources[0].videoId === 'tmdb:12345', 'D: tmdb_id addon receives the tmdb: prefixed id');
  ok(calls[0].url === 'https://tmdb-addon.example/stream/movie/tmdb:12345.json', 'D: tmdb endpoint constructed per the addon id property');

  // Unsupported idProperty (mal_id) → addon skipped WITHOUT any request.
  const callsMal: Array<{ url: string; signal: AbortSignal | null }> = [];
  const fetcherMal = createFetcher({ '*': streamRoute([streamFixture()]) }, callsMal);
  const { client: clientMal } = fakeAddonClient([addonRowFixture({ id: '00000000-0000-4000-8000-0000000000d2', slug: 'mal-addon', id_property: 'mal_id' })]);
  const resolutionMal = await resolveStremioStreams(clientMal, movieRequest, { fetcher: fetcherMal, dnsResolver: publicResolver });
  ok(resolutionMal.sources.length === 0, 'D: unsupported idProperty yields no sources');
  ok(skippedWith(resolutionMal, '00000000-0000-4000-8000-0000000000d2', 'unsupported-id-property'), 'D: unsupported idProperty skipped with a typed reason');
  ok(callsMal.length === 0, 'D: no network request made for an unmappable idProperty');

  // Neither idProperty nor idPrefixes → protocol default (imdb_id).
  const callsDefault: Array<{ url: string; signal: AbortSignal | null }> = [];
  const fetcherDefault = createFetcher({ 'https://addon.example/stream/movie/tt1234567.json': streamRoute([streamFixture()]) }, callsDefault);
  const { client: clientDefault } = fakeAddonClient([addonRowFixture({ id_property: null, id_prefixes: [] })]);
  const resolutionDefault = await resolveStremioStreams(clientDefault, movieRequest, { fetcher: fetcherDefault, dnsResolver: publicResolver });
  ok(resolutionDefault.sources.length === 1 && resolutionDefault.sources[0].idProperty === 'imdb_id', 'D: undeclared property falls back to the protocol default (imdb_id)');

  // Unit level: inference from idPrefixes.
  const tmdbAddon = mapAddonRow(addonRowFixture({ id_property: null, id_prefixes: ['tmdb'] }) as never);
  ok(resolveAddonIdProperty(tmdbAddon) === 'tmdb_id', 'D: idPrefixes ["tmdb"] infer the tmdb_id property');
  const kaiAddon = mapAddonRow(addonRowFixture({ id_property: null, id_prefixes: ['kai'] }) as never);
  ok(resolveAddonIdProperty(kaiAddon) === null, 'D: unmappable prefixes infer no property');
}

// ---------------------------------------------------------------------------
// E. idPrefixes matching
// ---------------------------------------------------------------------------
{
  // Declared ['tt'] accepts the constructed IMDb id.
  const callsTt: Array<{ url: string; signal: AbortSignal | null }> = [];
  const fetcherTt = createFetcher({ 'https://addon.example/stream/movie/tt1234567.json': streamRoute([streamFixture()]) }, callsTt);
  const { client: clientTt } = fakeAddonClient([addonRowFixture()]);
  const resolutionTt = await resolveStremioStreams(clientTt, movieRequest, { fetcher: fetcherTt, dnsResolver: publicResolver });
  ok(resolutionTt.sources.length === 1, 'E: declared ["tt"] prefix accepts the IMDb video id');

  // Stream-scoped idPrefixes override the manifest-level list when present.
  const scopedAddon = mapAddonRow(
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000e1', slug: 'scoped-addon', id_prefixes: ['tt'], capabilities: { supportsStream: true, streamTypes: [], streamIdPrefixes: ['kai'] } }) as never,
  );
  const scopedPlan = planAddonStreamRequest(scopedAddon, 'movie', identifiers);
  ok(!scopedPlan.ok && scopedPlan.reason === 'id-prefix-mismatch', 'E: stream-scoped prefixes narrow the eligibility check');

  const scopedMatch = mapAddonRow(
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000e2', slug: 'scoped-match', capabilities: { supportsStream: true, streamTypes: [], streamIdPrefixes: ['tt'] } }) as never,
  );
  const scopedMatchPlan = planAddonStreamRequest(scopedMatch, 'movie', identifiers);
  ok(scopedMatchPlan.ok === true && scopedMatchPlan.ok && scopedMatchPlan.plan.videoId === 'tt1234567', 'E: stream-scoped prefixes match when compatible');
}

// ---------------------------------------------------------------------------
// F. Incompatible prefix → addon skipped without a request
// ---------------------------------------------------------------------------
{
  const calls: Array<{ url: string; signal: AbortSignal | null }> = [];
  const fetcher = createFetcher({ '*': streamRoute([streamFixture()]) }, calls);
  const { client } = fakeAddonClient([addonRowFixture({ id: '00000000-0000-4000-8000-0000000000f1', slug: 'kai-addon', id_property: 'imdb_id', id_prefixes: ['kai'] })]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  ok(resolution.sources.length === 0, 'F: incompatible prefix yields no sources');
  ok(skippedWith(resolution, '00000000-0000-4000-8000-0000000000f1', 'id-prefix-mismatch'), 'F: prefix mismatch skipped with a typed reason');
  ok(calls.length === 0, 'F: no network request made for an incompatible prefix');

  // Declared imdb property but tmdb-only prefixes → constructed tt id mismatches.
  const mismatchAddon = mapAddonRow(addonRowFixture({ id_property: 'imdb_id', id_prefixes: ['tmdb'] }) as never);
  const mismatchPlan = planAddonStreamRequest(mismatchAddon, 'movie', identifiers);
  ok(!mismatchPlan.ok && mismatchPlan.reason === 'id-prefix-mismatch', 'F: constructed id must match the declared prefixes');
}

// ---------------------------------------------------------------------------
// G. Unsupported media type → addon skipped
// ---------------------------------------------------------------------------
{
  const calls: Array<{ url: string; signal: AbortSignal | null }> = [];
  const fetcher = createFetcher({ '*': streamRoute([streamFixture()]) }, calls);
  const { client } = fakeAddonClient([addonRowFixture({ id: '00000000-0000-4000-8000-0000000000g1', slug: 'movie-only', supported_types: ['movie'] })]);
  const resolution = await resolveStremioStreams(client, seriesRequest, { fetcher, dnsResolver: publicResolver });
  ok(resolution.sources.length === 0, 'G: unsupported media type yields no sources');
  ok(skippedWith(resolution, '00000000-0000-4000-8000-0000000000g1', 'unsupported-media-type'), 'G: unsupported media type skipped with a typed reason');
  ok(calls.length === 0, 'G: no network request made for an unsupported type');

  // Anime content resolves through the series path (Mavero convention).
  ok(stremioStreamTypeFor('anime') === 'series' && stremioStreamTypeFor('movie') === 'movie' && stremioStreamTypeFor('series') === 'series', 'G: media type mapping (anime → series) is pinned');
}

// ---------------------------------------------------------------------------
// H. Disabled / non-usable addons never participate
// ---------------------------------------------------------------------------
{
  const calls: Array<{ url: string; signal: AbortSignal | null }> = [];
  const fetcher = createFetcher({ 'https://addon.example/stream/movie/tt1234567.json': streamRoute([streamFixture()]) }, calls);
  const { client } = fakeAddonClient([
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000h1', slug: 'disabled-addon', enabled: false }),
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000h2', slug: 'maintenance-addon', status: 'maintenance' }),
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000h3', slug: 'unavailable-addon', status: 'unavailable' }),
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000h4', slug: 'experimental-addon', status: 'experimental' }),
  ]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  ok(resolution.consideredAddons === 1, 'H: only enabled+usable addons are loaded (disabled/maintenance/unavailable excluded)');
  ok(resolution.sources.length === 1, 'H: experimental addon participates (enabled=true is the admin opt-in)');
  ok(calls.length === 1, 'H: no request ever reaches a disabled addon');
  // Query contract pin: the default loader filters enabled + usable statuses.
}

// ---------------------------------------------------------------------------
// I. Addon without EXPLICIT stream capability → skipped
// ---------------------------------------------------------------------------
{
  const calls: Array<{ url: string; signal: AbortSignal | null }> = [];
  const fetcher = createFetcher({ '*': streamRoute([streamFixture()]) }, calls);
  const { client } = fakeAddonClient([
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000i1', slug: 'catalog-only', resources: ['catalog', 'meta'], capabilities: { supportsStream: false, manifestId: 'c.x', manifestVersion: '1.0.0', normalizedAt: 'now', streamTypes: [], streamIdPrefixes: [] } }),
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000i2', slug: 'no-capability', capabilities: {} }),
  ]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  ok(resolution.sources.length === 0, 'I: no stream capability → no sources');
  ok(skippedWith(resolution, '00000000-0000-4000-8000-0000000000i1', 'no-stream-capability'), 'I: supportsStream=false addon skipped');
  ok(skippedWith(resolution, '00000000-0000-4000-8000-0000000000i2', 'no-stream-capability'), 'I: missing capability data fails closed');
  ok(calls.length === 0, 'I: addons without an explicit stream resource are never called');
}

// ---------------------------------------------------------------------------
// J. Valid stream response — full normalization
// ---------------------------------------------------------------------------
{
  const calls: Array<{ url: string; signal: AbortSignal | null }> = [];
  const fetcher = createFetcher({ 'https://addon.example/stream/movie/tt1234567.json': streamRoute([{ name: 'Example', title: 'Example 1080p', url: 'https://cdn.example/example.m3u8', behaviorHints: { bingeGroup: 'example-group', filename: 'example.1080p.mkv', videoSize: 1_500_000_000 } }]) }, calls);
  const { client } = fakeAddonClient([addonRowFixture()]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  ok(resolution.sources.length === 1, 'J: valid response yields one source');
  const source = resolution.sources[0];
  ok(source.streamName === 'Example' && source.streamTitle === 'Example 1080p', 'J: name/title preserved');
  ok(source.protocol === 'hls' && source.transport === 'https', 'J: protocol + transport detected');
  ok(source.quality.label === '1080p' && source.quality.height === 1080, 'J: quality extracted');
  ok(source.bingeGroup === 'example-group' && source.filename === 'example.1080p.mkv' && source.videoSize === 1_500_000_000, 'J: behaviorHints metadata preserved');
  ok(source.url === 'https://cdn.example/example.m3u8', 'J: URL unchanged');
}

// ---------------------------------------------------------------------------
// K. Multiple streams from one addon
// ---------------------------------------------------------------------------
{
  const fetcher = createFetcher({
    'https://addon.example/stream/movie/tt1234567.json': streamRoute([
      streamFixture({ name: 's1', title: '1080p', url: 'https://cdn.example/one.m3u8' }),
      streamFixture({ name: 's2', title: '720p', url: 'https://cdn.example/two.mp4' }),
      streamFixture({ name: 's3', title: '2160p', url: 'https://cdn.example/three.m3u8' }),
    ]),
  }, []);
  const { client } = fakeAddonClient([addonRowFixture()]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  // Phase 14 (external-downloader architecture): the native player keeps
  // ONLY addon HLS streams. The MP4 direct file is ISOLATED from playback —
  // it is served by the Mavero Downloader surface instead.
  ok(resolution.sources.length === 2, 'K: the two HLS streams are returned (direct files are isolated to the Mavero Downloader)');
  ok(resolution.sources.map((source) => source.streamIndex).join(',') === '0,2', 'K: stream order preserved within the addon (isolated entry skipped)');
  ok(resolution.sources.every((source) => source.protocol === 'hls'), 'K: every player source is HLS');
  ok(resolution.diagnostics.find((entry) => entry.status === 'ok')?.streamCount === 2, 'K: the addon diagnostic counts the PLAYER-offered streams');
}

// ---------------------------------------------------------------------------
// L. Multiple addons contribute
// ---------------------------------------------------------------------------
{
  const fetcher = createFetcher({
    'https://addon.example/stream/movie/tt1234567.json': streamRoute([streamFixture({ url: 'https://cdn-a.example/one.m3u8' })]),
    'https://other.example/stream/movie/tt1234567.json': streamRoute([streamFixture({ url: 'https://cdn-b.example/two.mp4' })]),
  }, []);
  const { client } = fakeAddonClient([
    addonRowFixture(),
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000l1', name: 'Other Addon', slug: 'other-addon', manifest_url: 'https://other.example/manifest.json', ordering: 2 }),
  ]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  // Phase 14: both addons RESOLVE ok, but the second addon's only stream is
  // an MP4 direct file — isolated from the native player (Mavero Downloader
  // surface). The aggregate keeps the first addon's HLS stream.
  ok(resolution.sources.length === 1, 'L: HLS sources from both resolving addons are kept (direct files isolated)');
  ok(new Set(resolution.diagnostics.filter((entry) => entry.status === 'ok').map((entry) => entry.addonId)).size === 2, 'L: both addons still report ok (isolation is not a failure)');
  ok(resolution.diagnostics.filter((entry) => entry.status === 'ok').length === 2, 'L: both addons report ok');
}

// ---------------------------------------------------------------------------
// M. Bounded parallel execution (controlled promises, no sleeps)
// ---------------------------------------------------------------------------
{
  const gates: Array<ReturnType<typeof deferred>> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetcher = (async (input: string | URL) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
    inFlight -= 1;
    // Unique media URL per addon — otherwise dedupe would legitimately merge them.
    const unique = String(input).replace(/[^a-z0-9]/gi, '');
    return streamRoute([streamFixture({ url: `https://cdn.example/${unique}.m3u8` })])();
  }) as typeof fetch;
  const rows = [1, 2, 3, 4, 5, 6].map((index) => addonRowFixture({ id: `00000000-0000-4000-8000-00000000000m${index}`, slug: `addon-m${index}`, manifest_url: `https://addon-m${index}.example/manifest.json`, ordering: index }));
  const { client } = fakeAddonClient(rows);
  const pending = resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  await spinUntil(() => gates.length >= 4);
  ok(gates.length === 4 && maxInFlight === 4, 'M: exactly STREAM_RESOLUTION_CONCURRENCY requests in flight');
  gates[0].resolve();
  await spinUntil(() => gates.length >= 5);
  ok(maxInFlight === 4, 'M: a released slot starts the next queued addon without exceeding the limit');
  ok(gates.length === 5, 'M: the sixth addon is still queued');
  // Release gates as they appear until the resolution settles (the sixth
  // addon's gate is created only after a slot frees up).
  for (let round = 0; round < 20; round += 1) {
    for (const gate of gates.splice(0)) gate.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (gates.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (gates.length === 0) break;
    }
  }
  const resolution = await pending;
  ok(resolution.sources.length === 6, 'M: all six addons resolved');
  ok(maxInFlight === 4, 'M: concurrency never exceeded the server-side limit');
  ok(STREAM_RESOLUTION_CONCURRENCY === 4, 'M: concurrency constant pinned to 4');
}

// ---------------------------------------------------------------------------
// N. Addon timeout — isolated, other addons still resolve (AI)
// ---------------------------------------------------------------------------
{
  const hangingFetcher = (async (input: string | URL, init?: RequestInit) => {
    if (String(input).includes('slow.example')) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
      });
    }
    return streamRoute([streamFixture({ url: 'https://cdn.example/good.m3u8' })])();
  }) as typeof fetch;
  const { client } = fakeAddonClient([
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000n1', name: 'Slow Addon', slug: 'slow-addon', manifest_url: 'https://slow.example/manifest.json', ordering: 1 }),
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000n2', name: 'Good Addon', slug: 'good-addon', manifest_url: 'https://good.example/manifest.json', ordering: 2 }),
  ]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher: hangingFetcher, dnsResolver: publicResolver, timeoutMs: 25 });
  ok(failedWith(resolution, '00000000-0000-4000-8000-0000000000n1', 'TIMEOUT'), 'N: slow addon fails with a typed TIMEOUT');
  ok(resolution.sources.length === 1 && resolution.sources[0].addonId === '00000000-0000-4000-8000-0000000000n2', 'N: the timed-out addon never blocks the others (AI)');
}

// ---------------------------------------------------------------------------
// O. Addon HTTP 500 — typed failure, isolated
// ---------------------------------------------------------------------------
{
  const fetcher = createFetcher({
    'https://addon.example/stream/movie/tt1234567.json': streamRoute([streamFixture()], 500),
    'https://good.example/stream/movie/tt1234567.json': streamRoute([streamFixture({ url: 'https://cdn.example/good.m3u8' })]),
  }, []);
  const { client } = fakeAddonClient([
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000o1', name: 'Broken Addon', slug: 'broken-addon', ordering: 1 }),
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000o2', name: 'Good Addon', slug: 'good-addon', manifest_url: 'https://good.example/manifest.json', ordering: 2 }),
  ]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  ok(failedWith(resolution, '00000000-0000-4000-8000-0000000000o1', 'HTTP_ERROR'), 'O: HTTP 500 fails with a typed HTTP_ERROR');
  ok(resolution.sources.length === 1, 'O: the failing addon does not affect the healthy one');
}

// ---------------------------------------------------------------------------
// P. Invalid JSON
// ---------------------------------------------------------------------------
{
  const fetcher = createFetcher({ 'https://addon.example/stream/movie/tt1234567.json': jsonRoute('<html>not json</html>') }, []);
  const { client } = fakeAddonClient([addonRowFixture({ id: '00000000-0000-4000-8000-0000000000p1', slug: 'html-addon' })]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  ok(failedWith(resolution, '00000000-0000-4000-8000-0000000000p1', 'INVALID_JSON'), 'P: non-JSON body fails with INVALID_JSON');
  ok(resolution.sources.length === 0, 'P: no sources from an invalid body');
}

// ---------------------------------------------------------------------------
// Q. Malformed stream response (non-object entries are classified, not fatal)
// ---------------------------------------------------------------------------
{
  const fetcher = createFetcher({
    'https://addon.example/stream/movie/tt1234567.json': streamRoute(['not-an-object', 42, streamFixture()]),
  }, []);
  const { client } = fakeAddonClient([addonRowFixture()]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  ok(resolution.sources.length === 1, 'Q: valid entries survive malformed siblings');
  ok(resolution.unsupported.filter((entry) => entry.reason === 'not-an-object').length === 2, 'Q: malformed entries recorded as unsupported');
  ok(diagnosticFor(resolution, addonRowFixture().id as string)?.status === 'ok', 'Q: the addon itself still reports ok');

  // A top-level array is an invalid response shape.
  const arrayFetcher = createFetcher({ 'https://addon.example/stream/movie/tt1234567.json': jsonRoute('[1,2,3]') }, []);
  const { client: arrayClient } = fakeAddonClient([addonRowFixture({ id: '00000000-0000-4000-8000-0000000000q2', slug: 'array-addon' })]);
  const arrayResolution = await resolveStremioStreams(arrayClient, movieRequest, { fetcher: arrayFetcher, dnsResolver: publicResolver });
  ok(failedWith(arrayResolution, '00000000-0000-4000-8000-0000000000q2', 'INVALID_RESPONSE'), 'Q: top-level array response is INVALID_RESPONSE');
}

// ---------------------------------------------------------------------------
// R. Missing streams array
// ---------------------------------------------------------------------------
{
  const fetcher = createFetcher({ 'https://addon.example/stream/movie/tt1234567.json': jsonRoute('{"foo": "bar"}') }, []);
  const { client } = fakeAddonClient([addonRowFixture({ id: '00000000-0000-4000-8000-0000000000r1', slug: 'no-streams-addon' })]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  ok(failedWith(resolution, '00000000-0000-4000-8000-0000000000r1', 'INVALID_RESPONSE'), 'R: missing streams array is an invalid response');
}

// ---------------------------------------------------------------------------
// S. Empty streams array — valid, zero sources
// ---------------------------------------------------------------------------
{
  const fetcher = createFetcher({ 'https://addon.example/stream/movie/tt1234567.json': streamRoute([]) }, []);
  const { client } = fakeAddonClient([addonRowFixture()]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  ok(resolution.sources.length === 0, 'S: empty streams array yields zero sources');
  const diagnostic = diagnosticFor(resolution, addonRowFixture().id as string);
  ok(diagnostic?.status === 'ok' && diagnostic.streamCount === 0, 'S: addon reports ok with streamCount 0');
  ok(typeof resolution.elapsedMs === 'number', 'S: empty result is a normal outcome, not an error');
}

// ---------------------------------------------------------------------------
// T/U. HTTP and HTTPS stream URLs accepted and preserved (never rewritten)
// ---------------------------------------------------------------------------
{
  const normalize = (streams: unknown[]) => normalizeStremioStreamResponse({ streams });
  const http = normalize([streamFixture({ url: 'http://cdn.example/video.mp4' })]);
  ok(http.streams.length === 1 && http.streams[0].url === 'http://cdn.example/video.mp4', 'T: http stream accepted and NOT rewritten to https');
  ok(http.streams[0].transport === 'http', 'T: http transport recorded');
  const https = normalize([streamFixture({ url: 'https://cdn.example/video.mp4' })]);
  ok(https.streams[0].transport === 'https', 'U: https transport recorded');

  const calls: Array<{ url: string; signal: AbortSignal | null }> = [];
  const fetcher = createFetcher({ 'https://addon.example/stream/movie/tt1234567.json': streamRoute([streamFixture({ url: 'http://cdn.example/video.mp4' })]) }, calls);
  const { client } = fakeAddonClient([addonRowFixture()]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  // Phase 14: the http direct file is preserved VERBATIM by normalization
  // (assertions above) but isolated from the player aggregate — the Mavero
  // Downloader surface serves it with the exact same untouched URL.
  ok(resolution.sources.length === 0, 'T: the http direct file is isolated from the player aggregate (its verbatim URL is pinned by normalization + the Phase 14 downloader suite)');
}

// ---------------------------------------------------------------------------
// V/W. Protocol detection — HLS and MP4
// ---------------------------------------------------------------------------
{
  const hls = normalizeStremioStreamResponse({ streams: [streamFixture({ url: 'https://cdn.example/master.m3u8' })] });
  ok(hls.streams[0].protocol === 'hls', 'V: .m3u8 detected as hls');
  const mp4 = normalizeStremioStreamResponse({ streams: [streamFixture({ url: 'https://cdn.example/movie.mp4' })] });
  ok(mp4.streams[0].protocol === 'mp4', 'W: .mp4 detected as mp4');
  const extensionLess = normalizeStremioStreamResponse({ streams: [streamFixture({ url: 'https://cdn.example/dl/abc123' })] });
  ok(extensionLess.streams[0].protocol === 'unknown', 'W: extension-less URLs are honestly unknown (no fabricated protocol)');
}

// ---------------------------------------------------------------------------
// X/Y/Z. magnet / infoHash / torrent rejected
// ---------------------------------------------------------------------------
{
  const magnet = normalizeStremioStreamResponse({ streams: [streamFixture({ url: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=example' })] });
  ok(magnet.streams.length === 0 && magnet.unsupported[0]?.reason === 'non-http-url', 'X: magnet: URI rejected (non-http scheme)');

  const infoHash = normalizeStremioStreamResponse({ streams: [{ name: 'torrent', infoHash: '0123456789abcdef0123456789abcdef01234567' }] });
  ok(infoHash.streams.length === 0 && infoHash.unsupported[0]?.reason === 'torrent', 'Y: infoHash stream rejected');

  // Conservative: a torrent-tagged stream carrying a direct URL is still rejected.
  const mixed = normalizeStremioStreamResponse({ streams: [{ name: 'hybrid', url: 'https://cdn.example/video.mp4', infohash: '0123456789abcdef0123456789abcdef01234567' }] });
  ok(mixed.streams.length === 0 && mixed.unsupported[0]?.reason === 'torrent', 'Y: infoHash metadata never turns into a playable source');

  const torrentFile = normalizeStremioStreamResponse({ streams: [streamFixture({ url: 'https://tracker.example/file.torrent' })] });
  ok(torrentFile.streams.length === 0 && torrentFile.unsupported[0]?.reason === 'torrent', 'Z: .torrent URL rejected');
  const torrentHost = normalizeStremioStreamResponse({ streams: [streamFixture({ url: 'https://torrent.example/dl/file.mp4' })] });
  ok(torrentHost.streams.length === 0 && torrentHost.unsupported[0]?.reason === 'torrent', 'Z: torrent-ish host rejected');
  const debridHost = normalizeStremioStreamResponse({ streams: [streamFixture({ url: 'https://debrid.example/dl/file.mp4' })] });
  ok(debridHost.streams.length === 0 && debridHost.unsupported[0]?.reason === 'torrent', 'Z: debrid URL rejected');
  const legacy = normalizeStremioStreamResponse({ streams: [{ name: 'legacy', url: 'https://cdn.example/video.mp4', sources: ['tracker:0123...'] }] });
  ok(legacy.streams.length === 0 && legacy.unsupported[0]?.reason === 'torrent', 'Z: legacy torrent sources field rejected');

  // A legitimate stream whose title merely MENTIONS torrents stays playable.
  const descriptive = normalizeStremioStreamResponse({ streams: [streamFixture({ title: '1080p (not a torrent)' })] });
  ok(descriptive.streams.length === 1, 'Z: descriptive text never rejects a valid HTTP stream');
}

// ---------------------------------------------------------------------------
// AA. externalUrl rejected — never playable media
// ---------------------------------------------------------------------------
{
  const external = normalizeStremioStreamResponse({ streams: [{ name: 'web', externalUrl: 'https://web.example/watch/123' }] });
  ok(external.streams.length === 0 && external.unsupported[0]?.reason === 'external-url', 'AA: externalUrl-only entry rejected');

  const bothEntry = normalizeStremioStreamResponse({ streams: [{ name: 'both', url: 'https://cdn.example/video.mp4', externalUrl: 'https://web.example/watch/123' }] });
  ok(bothEntry.streams.length === 0 && bothEntry.unsupported[0]?.reason === 'external-url', 'AA: externalUrl marks the whole entry non-playable (conservative)');
}

// ---------------------------------------------------------------------------
// AB. javascript:/data:/blob:/file: rejected
// ---------------------------------------------------------------------------
{
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'blob:https://example/uuid', 'file:///etc/passwd', 'chrome-extension://abc/x']) {
    const result = normalizeStremioStreamResponse({ streams: [streamFixture({ url })] });
    ok(result.streams.length === 0 && result.unsupported[0]?.reason === 'non-http-url', `AB: ${url.split(':')[0]}: scheme rejected`);
  }
}

// ---------------------------------------------------------------------------
// AC. Credentials in a stream URL rejected
// ---------------------------------------------------------------------------
{
  const credentialed = normalizeStremioStreamResponse({ streams: [streamFixture({ url: 'https://user:pass@cdn.example/video.mp4' })] });
  ok(credentialed.streams.length === 0 && credentialed.unsupported[0]?.reason === 'credential-url', 'AC: credential URLs rejected');
}

// ---------------------------------------------------------------------------
// AD. Proxy-header-dependent streams excluded safely
// ---------------------------------------------------------------------------
{
  const headerDependent = normalizeStremioStreamResponse({
    streams: [
      streamFixture({ name: 'plain', url: 'https://cdn.example/plain.mp4' }),
      { name: 'headers required', title: '1080p', url: 'https://cdn.example/headers.m3u8', behaviorHints: { proxyHeaders: { 'User-Agent': 'ExampleAgent/1.0', Referer: 'https://addon.example/' } } },
    ],
  });
  ok(headerDependent.streams.length === 1 && headerDependent.streams[0].name === 'plain', 'AD: header-dependent stream excluded from the playable list');
  const excluded = headerDependent.unsupported[0];
  ok(excluded?.reason === 'header-dependent', 'AD: typed header-dependent reason recorded');
  ok(excluded?.requiredHeaderNames?.join(',') === 'User-Agent,Referer', 'AD: required header NAMES preserved for diagnostics');
  ok(!JSON.stringify(excluded).includes('ExampleAgent/1.0'), 'AD: header VALUES never preserved');
}

// ---------------------------------------------------------------------------
// AE. Duplicate URLs deduplicated; different URLs never merged
// ---------------------------------------------------------------------------
{
  const fetcher = createFetcher({
    'https://addon.example/stream/movie/tt1234567.json': streamRoute([streamFixture({ url: 'https://CDN.example/shared.m3u8' })]),
    'https://other.example/stream/movie/tt1234567.json': streamRoute([
      streamFixture({ url: 'https://cdn.example:443/shared.m3u8' }),
      streamFixture({ url: 'https://cdn.example/unique.mp4', title: 'same title as shared' }),
    ]),
  }, []);
  const { client } = fakeAddonClient([
    addonRowFixture({ ordering: 1 }),
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000ae1', name: 'Other Addon', slug: 'other-addon', manifest_url: 'https://other.example/manifest.json', ordering: 2 }),
  ]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  // Phase 14: the two HLS variants dedupe to ONE player source; the unique
  // MP4 direct file is isolated from the player aggregate (Mavero Downloader
  // surface). Dedupe identity itself is unchanged (host-case + default port).
  ok(resolution.sources.length === 1, 'AE: equivalent URLs (host-case/default-port variants) deduplicated (the unique MP4 direct file is isolated — Phase 14)');
  ok(resolution.sources[0].url === 'https://cdn.example/shared.m3u8', 'AE: first occurrence (deterministic order) wins — WHATWG hostname normalization is expected');
}

// ---------------------------------------------------------------------------
// AF. Deterministic ordering — a slow addon cannot reorder results
// ---------------------------------------------------------------------------
{
  const gates: Array<ReturnType<typeof deferred>> = [];
  const fetcher = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes('slow-first.example')) {
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      return streamRoute([streamFixture({ url: 'https://cdn.example/first.m3u8' })])();
    }
    return streamRoute([streamFixture({ url: 'https://cdn.example/second.m3u8' })])();
  }) as typeof fetch;
  const { client } = fakeAddonClient([
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000af1', name: 'A First Addon', slug: 'first-addon', manifest_url: 'https://slow-first.example/manifest.json', ordering: 1 }),
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000af2', name: 'B Second Addon', slug: 'second-addon', manifest_url: 'https://fast.example/manifest.json', ordering: 2 }),
  ]);
  const pending = resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  await spinUntil(() => gates.length >= 1);
  gates[0].resolve();
  const resolution = await pending;
  ok(resolution.sources.length === 2, 'AF: both sources resolved');
  ok(resolution.sources[0].addonOrdering === 1 && resolution.sources[0].url === 'https://cdn.example/first.m3u8', 'AF: ordering 1 addon comes first despite finishing LAST');
  ok(resolution.sources[1].addonOrdering === 2, 'AF: database ordering decides, not completion order');
}

// ---------------------------------------------------------------------------
// AG. Quality extraction — filename → title → name, then Auto
// ---------------------------------------------------------------------------
{
  const byTitle = normalizeStremioStreamResponse({ streams: [streamFixture({ name: 'Example', title: 'Movie 1080p WEB-DL' })] });
  ok(byTitle.streams[0].quality.label === '1080p' && byTitle.streams[0].quality.height === 1080, 'AG: 1080p extracted from title');
  const byFilename = normalizeStremioStreamResponse({ streams: [streamFixture({ title: 'no info here', behaviorHints: { filename: 'show.s01e01.2160p.mkv' } })] });
  ok(byFilename.streams[0].quality.height === 2160 && byFilename.streams[0].quality.label === '2160p', 'AG: filename is the most specific source');
  const fourK = normalizeStremioStreamResponse({ streams: [streamFixture({ title: 'Movie 4K HEVC' })] });
  ok(fourK.streams[0].quality.height === 2160, 'AG: 4K maps to 2160');
  const bitrate = normalizeStremioStreamResponse({ streams: [{ name: 'x', url: 'https://cdn.example/v.mp4', behaviorHints: {} }] });
  ok(bitrate.streams[0].quality.bitrate === undefined, 'AG: bitrate never fabricated');
  const unknown = normalizeStremioStreamResponse({ streams: [streamFixture({ name: 'Example', title: 'just a name' })] });
  ok(unknown.streams[0].quality.label === 'Auto' && unknown.streams[0].quality.height === undefined, 'AG: unknown quality becomes Auto (never a guessed resolution)');
}

// ---------------------------------------------------------------------------
// AH. Language / raw metadata preservation
// ---------------------------------------------------------------------------
{
  const fetcher = createFetcher({
    'https://addon.example/stream/movie/tt1234567.json': streamRoute([{ name: '[EN] Example', title: 'Example 1080p English (Multi Audio)', url: 'https://cdn.example/example.m3u8' }]),
  }, []);
  const { client } = fakeAddonClient([addonRowFixture()]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  const source = resolution.sources[0];
  ok(source.streamName === '[EN] Example', 'AH: stream name preserved verbatim for later UI');
  ok(source.streamTitle === 'Example 1080p English (Multi Audio)', 'AH: stream title preserved verbatim (language info kept raw, no NLP guessing)');
  const playerSource = stremioStreamToPlayerSource(source);
  ok(playerSource.metadata?.title === 'Example 1080p English (Multi Audio)', 'AH: language-bearing title flows into PlayerSource metadata');
}

// ---------------------------------------------------------------------------
// AJ. All addons fail → empty result, never a thrown error
// ---------------------------------------------------------------------------
{
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    if (String(input).includes('slow.example')) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
      });
    }
    return new Response('{"streams": [1]}', { status: 500 });
  }) as typeof fetch;
  const { client } = fakeAddonClient([
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000aj1', name: 'Slow', slug: 'slow', manifest_url: 'https://slow.example/manifest.json', ordering: 1 }),
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000aj2', name: 'Broken', slug: 'broken', manifest_url: 'https://broken.example/manifest.json', ordering: 2 }),
  ]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver, timeoutMs: 20 });
  ok(resolution.sources.length === 0, 'AJ: all-fail yields an EMPTY result (no throw, no 500)');
  ok(resolution.diagnostics.filter((entry) => entry.status === 'failed').length === 2, 'AJ: both failures diagnosed with typed codes');
}

// ---------------------------------------------------------------------------
// AK. Stream metadata retains full addon identity (Phase 6 UX prerequisite)
// ---------------------------------------------------------------------------
{
  const fetcher = createFetcher({ 'https://addon.example/stream/movie/tt1234567.json': streamRoute([streamFixture()]) }, []);
  const { client } = fakeAddonClient([addonRowFixture()]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  const source = resolution.sources[0];
  ok(source.addonId === addonRowFixture().id, 'AK: addon id retained');
  ok(source.addonSlug === 'example-http-addon' && source.addonName === 'Example HTTP Addon', 'AK: addon slug + name retained');
  ok(source.addonOrdering === 1 && source.streamIndex === 0, 'AK: addon ordering + original stream index retained');
  ok(typeof source.streamName === 'string' && typeof source.streamTitle === 'string', 'AK: stream name + title retained');
  ok(source.protocol === 'hls' && source.url.length > 0, 'AK: protocol + URL retained');
}

// ---------------------------------------------------------------------------
// AL. Response-size limit (default 512 KiB, enforced while streaming)
// ---------------------------------------------------------------------------
{
  const oversizedBody = JSON.stringify({ streams: [streamFixture({ name: 'x'.repeat(600_000) })] });
  const fetcher = createFetcher({
    'https://big.example/stream/movie/tt1234567.json': jsonRoute(oversizedBody),
    'https://good.example/stream/movie/tt1234567.json': streamRoute([streamFixture({ url: 'https://cdn.example/good.m3u8' })]),
  }, []);
  const { client } = fakeAddonClient([
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000al1', name: 'Big Addon', slug: 'big-addon', manifest_url: 'https://big.example/manifest.json', ordering: 1 }),
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000al2', name: 'Good Addon', slug: 'good-addon', manifest_url: 'https://good.example/manifest.json', ordering: 2 }),
  ]);
  ok(oversizedBody.length > STREAM_MAX_BYTES, 'AL: fixture exceeds the default cap');
  ok(STREAM_MAX_BYTES === 524_288, 'AL: default cap pinned to 512 KiB');
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  ok(failedWith(resolution, '00000000-0000-4000-8000-0000000000al1', 'TOO_LARGE'), 'AL: oversized stream response fails with TOO_LARGE');
  ok(resolution.sources.length === 1, 'AL: the oversized addon does not affect the healthy one');
}

// ---------------------------------------------------------------------------
// AM. Strict per-request timeout + aggregate budget constants
// ---------------------------------------------------------------------------
{
  ok(STREAM_REQUEST_TIMEOUT_MS === 10_000, 'AM: per-request timeout pinned to 10s');
  ok(STREAM_RESOLUTION_TIMEOUT_MS === 15_000, 'AM: aggregate budget pinned to 15s');
  const startedAt = Date.now();
  const hangingFetcher = (async (_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
  })) as typeof fetch;
  const { client } = fakeAddonClient([addonRowFixture({ id: '00000000-0000-4000-8000-0000000000am1', slug: 'hanging-addon' })]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher: hangingFetcher, dnsResolver: publicResolver, timeoutMs: 25, overallTimeoutMs: 60_000 });
  ok(failedWith(resolution, '00000000-0000-4000-8000-0000000000am1', 'TIMEOUT'), 'AM: hanging request aborted by the per-request timeout');
  ok(Date.now() - startedAt < 5_000, 'AM: the timeout fires promptly (no fixed sleeps)');
}

// ---------------------------------------------------------------------------
// AN. Encoded series IDs handled correctly (colons preserved, no mangling)
// ---------------------------------------------------------------------------
{
  const calls: Array<{ url: string; signal: AbortSignal | null }> = [];
  const fetcher = createFetcher({ 'https://addon.example/stream/series/tt1234567:2:13.json': streamRoute([streamFixture()]) }, calls);
  const { client } = fakeAddonClient([addonRowFixture()]);
  const resolution = await resolveStremioStreams(client, { ...seriesRequest, season: 2, episode: 13 }, { fetcher, dnsResolver: publicResolver });
  const requested = new URL(calls[0].url);
  ok(requested.pathname === '/stream/series/tt1234567:2:13.json', 'AN: colons preserved literally in the path (no %3A mangling)');
  ok(!calls[0].url.includes('%3A'), 'AN: video id semantics intact for the addon');
  ok(resolution.sources[0].videoId === 'tt1234567:2:13', 'AN: resolver reports the exact video id used');

  // Keyed manifests keep their query string on stream calls.
  const keyedUrl = buildStremioStreamUrl('https://addon.example/manifest.json?key=abc123', 'series', 'tt1234567:1:1');
  ok(keyedUrl === 'https://addon.example/stream/series/tt1234567:1:1.json?key=abc123', 'AN: keyed manifest query preserved on the stream endpoint');

  // Path traversal / arbitrary strings never become URL path segments.
  ok(buildStremioStreamUrl('https://addon.example/manifest.json', 'movie', '../secret') === null, 'AN: path traversal rejected by the video-id allowlist');
  ok(buildStremioStreamUrl('https://addon.example/manifest.json', 'movie', 'a b') === null, 'AN: whitespace in ids rejected');
  ok(buildStremioStreamUrl('https://addon.example/manifest.json', 'movie', 'x'.repeat(201)) === null, 'AN: over-long ids rejected');
  ok(buildStremioStreamUrl('https://addon.example/manifest.json', 'movie', 'tt1234567:1:1') === 'https://addon.example/stream/movie/tt1234567:1:1.json', 'AN: valid ids build the protocol path');
  ok(buildStremioStreamUrl('not-a-url', 'movie', 'tt1234567') === null, 'AN: invalid manifest URLs never build endpoints');
}

// ---------------------------------------------------------------------------
// AO. Existing provider behavior remains unchanged
// ---------------------------------------------------------------------------
{
  // The direct/embed URL contracts are untouched (https-only direct, embed
  // allowlist enforced) — Stremio adds a branch, it does not convert flows.
  let httpDirectRejected = false;
  try {
    validatePlaybackUrl('http://cdn.example/video.mp4', 'direct');
  } catch {
    httpDirectRejected = true;
  }
  ok(httpDirectRejected, 'AO: existing direct-URL contract unchanged (https-only)');
  ok(validatePlaybackUrl('https://cdn.example/video.mp4', 'direct') === 'https://cdn.example/video.mp4', 'AO: existing https direct URLs still validate');
  let embedAllowlist = false;
  try {
    validatePlaybackUrl('https://unlisted.example/embed/1', 'embed', ['https://allowed.example']);
  } catch {
    embedAllowlist = true;
  }
  ok(embedAllowlist, 'AO: existing embed allowlist contract unchanged');
  ok(protocolForUrl('https://cdn.example/x.m3u8') === 'hls' && protocolForUrl('https://cdn.example/x.mp4') === 'mp4', 'AO: protocol detection unchanged');

  // The resolver request contract is untouched.
  const parsed = parseResolverRequest({ sourceId: '00000000-0000-4000-8000-8000000000a1', contentId: '533535', mediaType: 'movie' });
  ok(parsed.mediaType === 'movie' && parsed.sourceId === '00000000-0000-4000-8000-8000000000a1', 'AO: parseResolverRequest unchanged');
  assert.throws(() => parseResolverRequest({ sourceId: '00000000-0000-4000-8000-8000000000a1', contentId: '533535', mediaType: 'movie', season: 1, episode: 1 }), 'AO: movie+season still rejected');

  // The existing template flow still resolves exactly as before.
  const providerId = '00000000-0000-4000-8000-8000000000a3';
  const sourceId = '00000000-0000-4000-8000-8000000000a4';
  const config = {
    provider: { id: providerId, name: 'Fixture Provider', status: 'active', enabled: true, integration_type: 'template' as const, adapter_id: null, capabilities: { movie: true } },
    source: {
      id: sourceId,
      provider_id: providerId,
      name: 'Fixture Source',
      status: 'active',
      enabled: true,
      visibility: 'public' as const,
      integration_type: 'template' as const,
      capabilities: { movie: true, allowed_embed_origins: ['https://embed.example'] },
      movie_template: 'https://embed.example/movie/{tmdb_id}',
      series_template: null,
      anime_template: null,
      identifier_mode: 'tmdb_id' as const,
      audio_languages: [],
      subtitle_capability: false,
      quality_capability: [],
    },
  };
  const content: NormalizedMediaItem = {
    id: '533535', title: 'Fixture', year: 2024, type: 'movie', runtime: '120 min', rating: 8, genres: [], description: '', poster: '', backdrop: '', accent: '#000000',
    source: { provider: 'tmdb', externalId: '533535', fetchedAt: new Date().toISOString() },
    externalIds: { tmdb: '533535' },
  };
  const existing = await resolveSourceFromConfig({ sourceId, contentId: '533535', mediaType: 'movie' }, config, content, { adapters: createDefaultAdapters() });
  ok(existing.type === 'embed' && existing.url === 'https://embed.example/movie/533535', 'AO: existing provider template resolution unchanged');
  ok(existing.providerId === providerId && existing.sourceId === sourceId, 'AO: existing provider identity contract unchanged');

  // The playback resolve endpoint does NOT import the Stremio resolver —
  // Stremio resolution is an additional branch, never mandatory (spec §30).
  const routeSource = readFileSync('src/routes/api/playback/resolve/+server.ts', 'utf8');
  ok(!routeSource.includes('stremio'), 'AO: existing resolve endpoint does not depend on the Stremio resolver');
}

// ---------------------------------------------------------------------------
// Security: media URLs are NEVER fetched server-side (spec §12/§32)
// ---------------------------------------------------------------------------
{
  const calls: Array<{ url: string; signal: AbortSignal | null }> = [];
  const fetcher = createFetcher({
    'https://addon.example/stream/movie/tt1234567.json': streamRoute([streamFixture({ url: 'https://private-media-cdn.example/video.m3u8' })]),
  }, calls);
  const { client } = fakeAddonClient([addonRowFixture()]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  ok(resolution.sources.length === 1, 'Security: media URL returned to the caller');
  ok(calls.every((call) => !call.url.includes('private-media-cdn.example')), 'Security: Mavero never fetches the media URL itself');
  ok(calls.length === 1 && calls[0].url.startsWith('https://addon.example/stream/'), 'Security: the only server-side fetch is the addon stream endpoint');

  // Addon endpoints keep manifest-grade SSRF protection (server connects to them).
  const callsBlocked: Array<{ url: string; signal: AbortSignal | null }> = [];
  const blockedFetcher = createFetcher({ '*': streamRoute([streamFixture()]) }, callsBlocked);
  const { client: blockedClient } = fakeAddonClient([addonRowFixture({ id: '00000000-0000-4000-8000-0000000000s1', slug: 'internal-addon', manifest_url: 'http://127.0.0.1:7000/manifest.json' })]);
  const blockedResolution = await resolveStremioStreams(blockedClient, movieRequest, { fetcher: blockedFetcher, dnsResolver: publicResolver });
  ok(failedWith(blockedResolution, '00000000-0000-4000-8000-0000000000s1', 'BLOCKED_URL'), 'Security: loopback stream endpoints blocked by the SSRF guard');
  ok(callsBlocked.length === 0, 'Security: blocked destinations are never connected to');

  // Raw addon responses are never copied into the result (normalized fields only).
  const resolutionJson = JSON.stringify(resolution);
  ok(!resolutionJson.includes('"streams"'), 'Security: raw addon response shape never leaks into the result');
}

// ---------------------------------------------------------------------------
// PlayerSource adapter (Phase 3 output shape, nothing wired into the player)
// ---------------------------------------------------------------------------
{
  const fetcher = createFetcher({ 'https://addon.example/stream/movie/tt1234567.json': streamRoute([streamFixture()]) }, []);
  const { client } = fakeAddonClient([addonRowFixture()]);
  const resolution = await resolveStremioStreams(client, movieRequest, { fetcher, dnsResolver: publicResolver });
  const playerSource = stremioStreamToPlayerSource(resolution.sources[0]);
  ok(playerSource.type === 'direct', 'Adapter: Stremio streams map to the direct PlayerSource type');
  ok(playerSource.url === resolution.sources[0].url, 'Adapter: URL preserved verbatim');
  ok(playerSource.providerId === resolution.sources[0].addonId, 'Adapter: providerId is the real streaming_addons id (no fake uuid invented)');
  ok(playerSource.sourceId === stremioSourceId('example-http-addon', 0) && playerSource.sourceId === 'stremio:example-http-addon:0', 'Adapter: deterministic synthetic source key');
  ok(playerSource.mediaType === 'movie', 'Adapter: media type mapped');
  ok(playerSource.metadata?.protocol === 'hls' && playerSource.metadata?.sourceName === 'Example HTTP Addon', 'Adapter: protocol + addon identity in metadata');
  ok(playerSource.qualities?.length === 1 && playerSource.qualities[0].label === '1080p', 'Adapter: quality option populated');
  ok(playerSource.headers === undefined, 'Adapter: headers never populated (header-dependent streams excluded upstream)');
  ok(playerSource.sandboxPolicy === undefined, 'Adapter: sandbox policy not fabricated for direct streams');
  ok(JSON.stringify(playerSource).toLowerCase().includes('m3u8') === true, 'Adapter: playable URL present for the future player consumption');
}

console.log(`stremio_addons_phase3_test: ${passed} checks passed`);
