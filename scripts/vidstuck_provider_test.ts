import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { createDefaultAdapters } from '$lib/server/resolver/adapters';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { TrustedResolutionConfig } from '$lib/server/resolver/types';
import type { PlayerSource } from '$lib/shared/player';
import { PlaybackManager } from '$lib/client/player/PlaybackManager';
import { createDefaultAdapterRegistry } from '$lib/client/player/adapter-registry';
import { VidStuckPlayerAdapter } from '$lib/client/player/providers/vidstuck-adapter';
import { VIDSTUCK_CAPABILITIES, PROVIDER_CAPABILITY_MAP } from '$lib/client/player/capabilities';
import type { PlayerEvent } from '$lib/client/player/events';

// VidStuck provider integration tests (2026-09-26 production integration).
//
// Verified provider contract (https://embed.vidstuck.xyz/documentation +
// live capture + player-bundle code):
//   Movie: https://vidstuck.xyz/embed/movie/{tmdbId}
//   TV:    https://vidstuck.xyz/embed/tv/{tmdbId}/{season}/{episode}
//          (vidstuck.xyz 302-redirects to embed.vidstuck.xyz — the origin
//           that serves the player AND sends postMessage)
//   ?branding=Mavero (fixed), ?server=centaurus (default internal server),
//   ?color=<hex without #> (accent, injected dynamically client-side),
//   ?progress=N (resume seconds — verified live)
//   postMessage (origin https://embed.vidstuck.xyz):
//     VIDEO_PROGRESS {type, payload:{currentTime, duration, tmdbId,
//       media_type, season, episode}} (live/bundle object form) and the
//       documented legacy JSON-string form {id, type, progress, timestamp,
//       duration, season, episode}.
//   ONE Mavero source; internal servers stay provider-internal.

const providerId = '00000000-0000-4000-8000-0000000000vs1';
const EMBED_HOST = 'https://vidstuck.xyz';
const MESSAGE_ORIGIN = 'https://embed.vidstuck.xyz';

// Mirrors migration 20261006000000_vidstuck_provider.sql exactly.
const capabilities = {
  movie: true, series: true, anime: false,
  result_type: 'embed', supports_episode: true, supports_direct: false,
  supports_server_selection: true, automatic_server_fallback: false,
  supports_subtitles: false, supports_language_selection: false, supports_download: false,
  allow_experimental_playback: false,
  allowed_embed_origins: [EMBED_HOST, MESSAGE_ORIGIN],
};
const config: TrustedResolutionConfig = {
  provider: { id: providerId, name: 'VidStuck', status: 'active', enabled: true, integration_type: 'template', adapter_id: 'vidstuck', capabilities },
  source: {
    id: 's1', provider_id: providerId, name: 'VidStuck',
    status: 'active', enabled: true, visibility: 'public', integration_type: 'template',
    capabilities,
    movie_template: `${EMBED_HOST}/embed/movie/{tmdb_id}?branding=Mavero&server=centaurus`,
    series_template: `${EMBED_HOST}/embed/tv/{tmdb_id}/{season}/{episode}?branding=Mavero&server=centaurus`,
    anime_template: null, identifier_mode: 'tmdb_id',
    audio_languages: ['multi'], subtitle_capability: false, quality_capability: [],
  },
};

const adapters = createDefaultAdapters();

function content(type: 'movie' | 'series', tmdb: string): NormalizedMediaItem {
  return {
    id: tmdb, title: 'Fixture', year: 2024, type, runtime: '120 min', rating: 8,
    genres: ['Drama'], description: 'Fixture',
    poster: 'https://image.example.test/poster.jpg', backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#00ff9c',
    source: { provider: 'tmdb', externalId: tmdb, fetchedAt: new Date().toISOString() },
    externalIds: { tmdb },
  };
}

// --- URL building (server-side resolver) ---

// Test 9: Movie 299534 → branding=Mavero + server=centaurus (color is added
// client-side; progress on resume).
const movie = await resolveSourceFromConfig(
  { sourceId: 's1', contentId: '299534', mediaType: 'movie' },
  config, content('movie', '299534'), { adapters },
);
assert.equal(movie.type, 'embed');
assert.equal(movie.url, 'https://vidstuck.xyz/embed/movie/299534?branding=Mavero&server=centaurus');

// Test 10: TV 1399 S2E5 → season/episode in path + branding + server preserved.
const tv = await resolveSourceFromConfig(
  { sourceId: 's1', contentId: '1399', mediaType: 'series', season: 2, episode: 5 },
  config, content('series', '1399'), { adapters },
);
assert.equal(tv.url, 'https://vidstuck.xyz/embed/tv/1399/2/5?branding=Mavero&server=centaurus');
assert.ok(tv.url.includes('/tv/1399/2/5'), 'season=2 episode=5 in path (never 1/1)');

// --- Migration content assertions ---

const migration = readFileSync(resolve('supabase/migrations/20261006000000_vidstuck_provider.sql'), 'utf-8');
assert.ok(migration.includes('https://vidstuck.xyz/embed/movie/{tmdb_id}?branding=Mavero&server=centaurus'), 'migration: movie template');
assert.ok(migration.includes('https://vidstuck.xyz/embed/tv/{tmdb_id}/{season}/{episode}?branding=Mavero&server=centaurus'), 'migration: series template');
assert.equal((migration.match(/insert into public\.streaming_sources/g) ?? []).length, 1, 'exactly ONE VidStuck source row');
// Test 18 (architecture): internal VidStuck servers are NOT Mavero sources.
for (const internal of ['vidstuck-andromeda', 'vidstuck-centaurus', 'vidstuck-atlas', 'vidstuck-milkyway']) {
  assert.ok(!migration.includes(internal), `internal server must not become a Mavero source: ${internal}`);
}
// Test 20: branding is always Mavero (and only Mavero).
const brandingValues = migration.match(/branding=[A-Za-z0-9]+/g) ?? [];
assert.ok(brandingValues.length >= 2, 'branding values present in templates/notes');
assert.ok(brandingValues.every((v) => v === 'branding=Mavero'), `every branding value is Mavero; got: ${brandingValues.join(', ')}`);
assert.ok(migration.includes("'vidstuck-embed'"), 'single source slug');
assert.ok(migration.includes("jsonb_build_array('https://vidstuck.xyz', 'https://embed.vidstuck.xyz')"), 'both documented origins allowlisted');

// --- Adapter contract (window/document/getComputedStyle mocks) ---

class MockMessageEvent {
  type: string; origin: string; data: unknown;
  constructor(type: string, init: { origin?: string; data?: unknown } = {}) {
    this.type = type; this.origin = init.origin ?? ''; this.data = init.data;
  }
}
const messageListeners = new Set<(event: { type: string; origin: string; data: unknown }) => void>();
let accentTokenValue = '#00ff9c'; // canonical Mavero --color-primary value
const mockWindow = {
  addEventListener: (_t: string, l: (e: { type: string; origin: string; data: unknown }) => void) => { if (_t === 'message') messageListeners.add(l); },
  removeEventListener: (_t: string, l: (e: unknown) => void) => { messageListeners.delete(l as never); },
  dispatchEvent: (event: { type: string; origin: string; data: unknown }) => {
    for (const l of messageListeners) { try { l(event); } catch { /* must never throw */ } }
    return true;
  },
  postMessage: () => { /* no-op */ },
  getComputedStyle: () => ({
    getPropertyValue: (name: string) => (name === '--color-primary' ? accentTokenValue : ''),
  }),
};
(globalThis as unknown as { window: unknown }).window = mockWindow;
(globalThis as unknown as { MessageEvent: unknown }).MessageEvent = MockMessageEvent;
(globalThis as unknown as { document: unknown }).document = { documentElement: {} };
function simulateMessage(origin: string, data: unknown): void {
  mockWindow.dispatchEvent(new MockMessageEvent('message', { origin, data }));
}
function makeSource(url: string): PlayerSource {
  return { type: 'embed', url, providerId, sourceId: 's1', mediaType: 'movie' };
}

const adapter = new VidStuckPlayerAdapter();
const events: PlayerEvent[] = [];
adapter.load({ source: makeSource('https://vidstuck.xyz/embed/movie/299534?branding=Mavero&server=centaurus') });
adapter.onEvent((e) => events.push(e));

assert.deepEqual(adapter.getCapabilities(), VIDSTUCK_CAPABILITIES);
assert.equal(PROVIDER_CAPABILITY_MAP['vidstuck'], VIDSTUCK_CAPABILITIES);
assert.equal(adapter.startAtParam(), 'progress', 'resume parameter is progress (seconds)');

// canHandle: documented host (302 origin) + post-redirect host.
assert.ok(adapter.canHandle(makeSource('https://vidstuck.xyz/embed/movie/299534?branding=Mavero&server=centaurus')), 'canHandle vidstuck.xyz embed');
assert.ok(adapter.canHandle(makeSource('https://embed.vidstuck.xyz/embed/movie/299534')), 'canHandle embed.vidstuck.xyz embed');
assert.ok(!adapter.canHandle(makeSource('https://www.moviesnexus.fun/movie/27205?sv=4k')), 'rejects other providers');

// Test 13: VIDEO_PROGRESS (live object form) → canonical timeupdate.
events.length = 0;
simulateMessage(MESSAGE_ORIGIN, {
  type: 'VIDEO_PROGRESS',
  payload: { currentTime: 120, duration: 10871.361, tmdbId: '299534', media_type: 'movie', season: 1, episode: 1 },
});
assert.equal(events.length, 1);
assert.deepEqual(events[0], { type: 'timeupdate', currentTime: 120, duration: 10871.361 });

// Test 14 (adapter half): duration flows through the event (persistence is
// the canonical pipeline's job — covered by the phase 2/4 suites).
assert.equal(events[0].type === 'timeupdate' && events[0].duration, 10871.361);

// Documented legacy JSON-string form is also accepted.
events.length = 0;
simulateMessage(MESSAGE_ORIGIN, JSON.stringify({
  id: '299534', type: 'movie', progress: 0.35, timestamp: 120, duration: 10871, season: 1, episode: 1,
}));
assert.deepEqual(events[0], { type: 'timeupdate', currentTime: 120, duration: 10871 });

// Test 15: no ended fabrication — VidStuck documents/observes NO ended
// event, and a 100%-progress message must NOT synthesize one.
events.length = 0;
simulateMessage(MESSAGE_ORIGIN, JSON.stringify({ id: '299534', type: 'movie', progress: 1, timestamp: 10871, duration: 10871, season: 1, episode: 1 }));
assert.equal(events.length, 1);
assert.equal(events[0].type, 'timeupdate', 'completion stays explicit — progress never becomes ended');

// Test 16: invalid origin ignored — ONLY the post-redirect origin is trusted.
for (const badOrigin of ['https://vidstuck.xyz', 'https://evil.example.com', 'https://www.moviesnexus.fun', '']) {
  events.length = 0;
  simulateMessage(badOrigin, { type: 'VIDEO_PROGRESS', payload: { currentTime: 5, duration: 100 } });
  assert.equal(events.length, 0, `message origin rejected: ${badOrigin || '(empty)'}`);
}

// Test 17: invalid event payloads ignored.
for (const bad of [
  { type: 'VIDEO_PROGRESS' },                                                    // no payload
  { type: 'VIDEO_PROGRESS', payload: null },                                     // null payload
  { type: 'VIDEO_PROGRESS', payload: 'x' },                                      // non-object payload
  { type: 'VIDEO_PROGRESS', payload: { duration: 100 } },                        // no currentTime
  { type: 'VIDEO_PROGRESS', payload: { currentTime: NaN, duration: 100 } },      // NaN
  { type: 'VIDEO_PROGRESS', payload: { currentTime: -3, duration: 100 } },       // negative
  { type: 'VIDEO_PROGRESS', payload: { currentTime: '120', duration: 100 } },    // string number
  JSON.stringify({ id: '1', type: 'movie', timestamp: 'x', duration: 5 }),       // legacy invalid timestamp
  JSON.stringify({ id: '1', type: 'bank-heist', timestamp: 5 }),                 // legacy wrong type discriminator
  'not json',
  42,
  null,
  { type: 'SOMETHING_ELSE', payload: { currentTime: 1, duration: 2 } },
]) {
  events.length = 0;
  simulateMessage(MESSAGE_ORIGIN, bad);
  assert.equal(events.length, 0, `invalid payload dropped: ${JSON.stringify(bad)}`);
}

// destroy() stops all events.
adapter.destroy();
events.length = 0;
simulateMessage(MESSAGE_ORIGIN, { type: 'VIDEO_PROGRESS', payload: { currentTime: 5, duration: 100 } });
assert.equal(events.length, 0, 'no events after destroy');

// Test 19: accent color is generated dynamically from the theme token.
// (a) exact token value → color param WITHOUT '#'.
assert.equal(
  adapter.finalizeEmbedUrl('https://vidstuck.xyz/embed/movie/299534?branding=Mavero&server=centaurus'),
  'https://vidstuck.xyz/embed/movie/299534?branding=Mavero&server=centaurus&color=00ff9c',
);
// (b) token without '#' also accepted.
accentTokenValue = '00ff9c';
assert.ok(adapter.finalizeEmbedUrl('https://vidstuck.xyz/embed/movie/299534')!.endsWith('color=00ff9c'));
// (c) invalid token → URL unchanged (null).
accentTokenValue = 'not-a-color';
assert.equal(adapter.finalizeEmbedUrl('https://vidstuck.xyz/embed/movie/299534'), null);
accentTokenValue = '';
assert.equal(adapter.finalizeEmbedUrl('https://vidstuck.xyz/embed/movie/299534'), null);
// (d) invalid URL input → null, never throws.
accentTokenValue = '#00ff9c';
assert.equal(adapter.finalizeEmbedUrl('not a url'), null);
// (e) no dupes — an existing color param is replaced, not duplicated.
accentTokenValue = '#00ff9c';
assert.equal(
  adapter.finalizeEmbedUrl('https://vidstuck.xyz/embed/movie/299534?color=FF0000'),
  'https://vidstuck.xyz/embed/movie/299534?color=00ff9c',
);
// (f) non-browser environment → null (URL unchanged).
const realWindow = (globalThis as unknown as { window: unknown }).window;
delete (globalThis as unknown as { window?: unknown }).window;
assert.equal(adapter.finalizeEmbedUrl('https://vidstuck.xyz/embed/movie/299534'), null);
(globalThis as unknown as { window: unknown }).window = realWindow;

// --- PlaybackManager end-to-end: resume + dynamic color on the final URL ---

function makeFetch(source: PlayerSource): typeof fetch {
  return async () => new Response(JSON.stringify({ ok: true, source }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }) as unknown as Response;
}

// Test 11: movie resume — progress=N appended, branding/server preserved,
// dynamic accent color injected (order: template params, progress, color).
{
  const manager = new PlaybackManager({
    fetcher: makeFetch(makeSource('https://vidstuck.xyz/embed/movie/299534?branding=Mavero&server=centaurus')),
    registry: createDefaultAdapterRegistry(),
  });
  await manager.loadSource({ sourceId: 's', contentId: '299534', mediaType: 'movie' }, 120, true);
  const url = manager.getSource()!.url!;
  assert.equal(url, 'https://vidstuck.xyz/embed/movie/299534?branding=Mavero&server=centaurus&progress=120&color=00ff9c');
  manager.dispose();
}

// Test 12: series resume — S2E5 path + progress + color.
{
  const manager = new PlaybackManager({
    fetcher: makeFetch(makeSource('https://vidstuck.xyz/embed/tv/1399/2/5?branding=Mavero&server=centaurus')),
    registry: createDefaultAdapterRegistry(),
  });
  await manager.loadSource({ sourceId: 's', contentId: '1399', mediaType: 'series', season: 2, episode: 5 }, 1200, true);
  const url = manager.getSource()!.url!;
  assert.ok(url.startsWith('https://vidstuck.xyz/embed/tv/1399/2/5?'), 'saved episode context preserved (2/5)');
  assert.ok(url.includes('branding=Mavero'), 'branding preserved');
  assert.ok(url.includes('server=centaurus'), 'server preserved');
  assert.ok(url.includes('progress=1200'), 'saved currentTime became the resume parameter');
  assert.ok(url.includes('color=00ff9c'), 'dynamic accent color injected');
  manager.dispose();
}

// No resume (startPosition 0) → no progress param; color still injected.
{
  const manager = new PlaybackManager({
    fetcher: makeFetch(makeSource('https://vidstuck.xyz/embed/movie/299534?branding=Mavero&server=centaurus')),
    registry: createDefaultAdapterRegistry(),
  });
  await manager.loadSource({ sourceId: 's', contentId: '299534', mediaType: 'movie' }, 0, true);
  const url = manager.getSource()!.url!;
  assert.ok(!url.includes('progress='), 'no resume param without saved progress');
  assert.ok(url.includes('color=00ff9c'), 'color still applied without resume');
  manager.dispose();
}

// Registry: VidStuck adapter is picked for vidstuck embed URLs.
{
  const registry = createDefaultAdapterRegistry();
  assert.ok(registry.pickAdapter(makeSource('https://vidstuck.xyz/embed/movie/299534')) instanceof VidStuckPlayerAdapter, 'registry picks VidStuck adapter');
  assert.ok(registry.pickAdapter(makeSource('https://embed.vidstuck.xyz/embed/movie/299534')) instanceof VidStuckPlayerAdapter, 'registry picks VidStuck adapter (post-redirect host)');
}

console.log('VidStuck provider integration tests passed: exact URLs (movie/TV with branding=Mavero & server=centaurus), progress resume verified live-style, dynamic theme-token color (no hardcoding), single Mavero source (internal servers stay internal), VIDEO_PROGRESS → canonical timeupdate (both live + legacy forms), duration flow, no ended fabrication, strict origin (embed.vidstuck.xyz only) + payload rejection, registry wiring.');
