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
import { MoviesNexusPlayerAdapter } from '$lib/client/player/providers/moviesnexus-adapter';
import { MOVIESNEXUS_CAPABILITIES, PROVIDER_CAPABILITY_MAP } from '$lib/client/player/capabilities';
import type { PlayerEvent } from '$lib/client/player/events';

// MoviesNexus provider integration tests (2026-09-26 production integration).
//
// Verified provider contract (https://www.moviesnexus.fun/ docs + live/code):
//   Movie: https://www.moviesnexus.fun/movie/{tmdbId}
//   TV:    https://www.moviesnexus.fun/tv/{tmdbId}/{season}/{episode}
//   ?sv= 4k | upcloud | nova | hydra | multiaudio | multiaudio2
//   ?startAt= resume seconds (canonical documented resume parameter)
//   postMessage origin https://www.moviesnexus.fun:
//     PLAYER_PROGRESS {currentTime, duration}
//     MOVIE_NEXUS_SERVERS {servers:[{id,name}]}
//     MOVIE_NEXUS_SERVER_FAILED {failedServerId}
//     PLAYER_FULLSCREEN_CHANGE {isFullscreen}
//
// Mavero exposes ONLY sv=4k and sv=multiaudio2 as sources.

const providerId = '00000000-0000-4000-8000-0000000000mn1';
const origin = 'https://www.moviesnexus.fun';

// Mirrors the capabilities + templates of migration
// 20261005000000_moviesnexus_provider.sql exactly.
function configFor(sv: '4k' | 'multiaudio2', sourceId: string): TrustedResolutionConfig {
  const capabilities = {
    movie: true, series: true, anime: false,
    result_type: 'embed', supports_episode: true, supports_direct: false,
    supports_server_selection: true, automatic_server_fallback: true,
    supports_subtitles: false, supports_language_selection: false, supports_download: false,
    allow_experimental_playback: false,
    allowed_embed_origins: [origin],
  };
  return {
    provider: { id: providerId, name: 'MoviesNexus', status: 'active', enabled: true, integration_type: 'template', adapter_id: 'moviesnexus', capabilities },
    source: {
      id: sourceId, provider_id: providerId, name: sv === '4k' ? 'MoviesNexus 4K' : 'MoviesNexus Multi Audio 2',
      status: 'active', enabled: true, visibility: 'public', integration_type: 'template',
      capabilities,
      movie_template: `${origin}/movie/{tmdb_id}?sv=${sv}`,
      series_template: `${origin}/tv/{tmdb_id}/{season}/{episode}?sv=${sv}`,
      anime_template: null, identifier_mode: 'tmdb_id',
      audio_languages: ['multi'], subtitle_capability: false, quality_capability: [],
    },
  };
}

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

// --- URL building (server-side resolver, template + sv preserved) ---

// Test 1: Movie 27205, source 4k → exact URL.
const movie4k = await resolveSourceFromConfig(
  { sourceId: 's1', contentId: '27205', mediaType: 'movie' },
  configFor('4k', 's1'), content('movie', '27205'), { adapters },
);
assert.equal(movie4k.type, 'embed');
assert.equal(movie4k.url, 'https://www.moviesnexus.fun/movie/27205?sv=4k');

// Test 2: Movie 27205, source multiaudio2 → exact URL (multiaudio2 preserved
// verbatim — NEVER silently changed to multiaudio).
const movieMa2 = await resolveSourceFromConfig(
  { sourceId: 's2', contentId: '27205', mediaType: 'movie' },
  configFor('multiaudio2', 's2'), content('movie', '27205'), { adapters },
);
assert.equal(movieMa2.url, 'https://www.moviesnexus.fun/movie/27205?sv=multiaudio2');
assert.ok(!movieMa2.url.includes('sv=multiaudio&'), 'multiaudio2 must not degrade to multiaudio');

// Test 3: Movie resume (currentTime=120) — client appends startAt=120 while
// preserving sv=4k (PlaybackManager-level, exactly what production does).
function makeFetch(source: PlayerSource): typeof fetch {
  return async () => new Response(JSON.stringify({ ok: true, source }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }) as unknown as Response;
}
function makeSource(url: string): PlayerSource {
  return { type: 'embed', url, providerId, sourceId: 's1', mediaType: 'movie' };
}
{
  const manager = new PlaybackManager({
    fetcher: makeFetch(makeSource('https://www.moviesnexus.fun/movie/27205?sv=4k')),
    registry: createDefaultAdapterRegistry(),
  });
  await manager.loadSource({ sourceId: 's', contentId: '27205', mediaType: 'movie' }, 120, true);
  const url = manager.getSource()!.url!;
  assert.equal(url, 'https://www.moviesnexus.fun/movie/27205?sv=4k&startAt=120');
  manager.dispose();
}

// Test 4: TV 1399 S1E1 4k → exact URL.
const tv4k = await resolveSourceFromConfig(
  { sourceId: 's1', contentId: '1399', mediaType: 'series', season: 1, episode: 1 },
  configFor('4k', 's1'), content('series', '1399'), { adapters },
);
assert.equal(tv4k.url, 'https://www.moviesnexus.fun/tv/1399/1/1?sv=4k');
assert.equal(tv4k.mediaType, 'series');

// Test 5: TV 1399 S2E5 multiaudio2 + resume 1200 → sv preserved + startAt=1200.
{
  const manager = new PlaybackManager({
    fetcher: makeFetch(makeSource('https://www.moviesnexus.fun/tv/1399/2/5?sv=multiaudio2')),
    registry: createDefaultAdapterRegistry(),
  });
  await manager.loadSource({ sourceId: 's', contentId: '1399', mediaType: 'series', season: 2, episode: 5 }, 1200, true);
  const url = manager.getSource()!.url!;
  assert.equal(url, 'https://www.moviesnexus.fun/tv/1399/2/5?sv=multiaudio2&startAt=1200');
  assert.ok(url.includes('/tv/1399/2/5'), 'season/episode context preserved (S2E5, not S1E1)');
  manager.dispose();
}

// --- Migration content assertions ---

const migrationPath = resolve('supabase/migrations/20261005000000_moviesnexus_provider.sql');
const migration = readFileSync(migrationPath, 'utf-8');
assert.ok(migration.includes("https://www.moviesnexus.fun/movie/{tmdb_id}?sv=4k"), 'migration: 4k movie template');
assert.ok(migration.includes("https://www.moviesnexus.fun/tv/{tmdb_id}/{season}/{episode}?sv=4k"), 'migration: 4k series template');
assert.ok(migration.includes("https://www.moviesnexus.fun/movie/{tmdb_id}?sv=multiaudio2"), 'migration: multiaudio2 movie template');
assert.ok(migration.includes("https://www.moviesnexus.fun/tv/{tmdb_id}/{season}/{episode}?sv=multiaudio2"), 'migration: multiaudio2 series template');
// ONLY the two requested server variants are exposed — no other sv sources.
const svSources = migration.match(/\?sv=[a-z0-9]+/g) ?? [];
assert.equal(new Set(svSources).size, 2, `exactly two sv variants exposed; got: ${svSources.join(',')}`);
assert.ok(!/upcloud|nova|hydra(?!.+auto-falls)|sv=multiaudio'|sv=multiaudio",/i.test(migration.replace(/--.*$/gm, '')), 'no other MoviesNexus server exposed as a source');
assert.equal((migration.match(/insert into public\.streaming_sources/g) ?? []).length, 2, 'exactly two source rows');
assert.ok(migration.includes("'moviesnexus'"), 'provider slug');
assert.ok(migration.includes("'moviesnexus-4k'") && migration.includes("'moviesnexus-multiaudio2'"), 'source slugs');
assert.ok(migration.includes("jsonb_build_array('https://www.moviesnexus.fun')"), 'allowed embed origins');

// --- Adapter contract ---

// Minimal window mock (same pattern as phase3_provider_adapters_test.ts).
class MockMessageEvent {
  type: string; origin: string; data: unknown;
  constructor(type: string, init: { origin?: string; data?: unknown } = {}) {
    this.type = type; this.origin = init.origin ?? ''; this.data = init.data;
  }
}
const messageListeners = new Set<(event: { type: string; origin: string; data: unknown }) => void>();
const mockWindow = {
  addEventListener: (_t: string, l: (e: { type: string; origin: string; data: unknown }) => void) => { if (_t === 'message') messageListeners.add(l); },
  removeEventListener: (_t: string, l: (e: unknown) => void) => { messageListeners.delete(l as never); },
  dispatchEvent: (event: { type: string; origin: string; data: unknown }) => {
    for (const l of messageListeners) { try { l(event); } catch { /* must never throw */ } }
    return true;
  },
  postMessage: () => { /* no-op */ },
};
(globalThis as unknown as { window: unknown }).window = mockWindow;
(globalThis as unknown as { MessageEvent: unknown }).MessageEvent = MockMessageEvent;
function simulateMessage(origin: string, data: unknown): void {
  mockWindow.dispatchEvent(new MockMessageEvent('message', { origin, data }));
}

const adapter = new MoviesNexusPlayerAdapter();
const events: PlayerEvent[] = [];
adapter.load({ source: makeSource(`${origin}/movie/27205?sv=4k`) });
adapter.onEvent((e) => events.push(e));

// Capabilities are the verified set and are registered under 'moviesnexus'.
assert.deepEqual(adapter.getCapabilities(), MOVIESNEXUS_CAPABILITIES);
assert.equal(PROVIDER_CAPABILITY_MAP['moviesnexus'], MOVIESNEXUS_CAPABILITIES);

// startAtParam is the canonical documented resume parameter.
assert.equal(adapter.startAtParam(), 'startAt');

// canHandle: origin match only.
assert.ok(adapter.canHandle(makeSource(`${origin}/movie/27205?sv=4k`)), 'canHandle 4k source');
assert.ok(adapter.canHandle(makeSource(`${origin}/movie/27205?sv=multiaudio2`)), 'canHandle multiaudio2 source');
assert.ok(!adapter.canHandle(makeSource('https://vidstuck.xyz/embed/movie/299534')), 'rejects other providers');
assert.ok(!adapter.canHandle({ type: 'direct', url: `${origin}/x.mp4`, providerId, sourceId: 's', mediaType: 'movie' }), 'rejects direct sources');

// Test 6: PLAYER_PROGRESS {currentTime, duration} → canonical timeupdate.
events.length = 0;
simulateMessage(origin, { type: 'PLAYER_PROGRESS', currentTime: 120, duration: 3600 });
assert.equal(events.length, 1, 'PLAYER_PROGRESS emits exactly one event');
assert.deepEqual(events[0], { type: 'timeupdate', currentTime: 120, duration: 3600 });

// JSON-string form is also accepted (safeParseMessage handles strings).
events.length = 0;
simulateMessage(origin, JSON.stringify({ type: 'PLAYER_PROGRESS', currentTime: 10, duration: 100 }));
assert.deepEqual(events[0], { type: 'timeupdate', currentTime: 10, duration: 100 });

// Test 7: invalid origin must be ignored.
events.length = 0;
simulateMessage('https://evil.example.com', { type: 'PLAYER_PROGRESS', currentTime: 1, duration: 2 });
simulateMessage('https://vidstuck.xyz', { type: 'PLAYER_PROGRESS', currentTime: 1, duration: 2 });
simulateMessage('', { type: 'PLAYER_PROGRESS', currentTime: 1, duration: 2 });
assert.equal(events.length, 0, 'messages from foreign origins are dropped');

// Test 8: invalid progress payloads must be ignored.
for (const bad of [
  { type: 'PLAYER_PROGRESS' },                                   // missing values
  { type: 'PLAYER_PROGRESS', currentTime: NaN, duration: 3600 }, // NaN
  { type: 'PLAYER_PROGRESS', currentTime: -5, duration: 3600 },  // negative
  { type: 'PLAYER_PROGRESS', currentTime: '120', duration: 3600 }, // string
  { type: 'PLAYER_PROGRESS', currentTime: Infinity, duration: 1 }, // infinite
  { type: 'PLAYER_PROGRESS', currentTime: 5 },                    // no duration (still valid — emits with undefined duration)
  'not json',
  null,
  { type: 'UNKNOWN_EVENT', currentTime: 1, duration: 2 },
]) {
  events.length = 0;
  simulateMessage(origin, bad);
  if (bad && typeof bad === 'object' && 'currentTime' in bad && (bad as { currentTime: number }).currentTime === 5) {
    // currentTime=5 without duration IS valid — duration is optional.
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { type: 'timeupdate', currentTime: 5, duration: undefined });
  } else {
    assert.equal(events.length, 0, `invalid payload dropped: ${JSON.stringify(bad)}`);
  }
}

// Metadata events are acknowledged (no crash, no fake PlayerEvents).
for (const meta of [
  { type: 'MOVIE_NEXUS_SERVERS', servers: [{ id: '4k', name: '4K Ultra' }] },
  { type: 'MOVIE_NEXUS_SERVER_FAILED', failedServerId: 'multiaudio2' },
  { type: 'PLAYER_FULLSCREEN_CHANGE', isFullscreen: true },
]) {
  events.length = 0;
  simulateMessage(origin, meta);
  assert.equal(events.length, 0, `${meta.type} must not fabricate a PlayerEvent`);
}

// destroy() stops all events.
adapter.destroy();
events.length = 0;
simulateMessage(origin, { type: 'PLAYER_PROGRESS', currentTime: 1, duration: 2 });
assert.equal(events.length, 0, 'no events after destroy');

// Registry: the MoviesNexus adapter is registered and wins over the generic
// embed fallback for moviesnexus.fun URLs.
{
  const registry = createDefaultAdapterRegistry();
  const picked = registry.pickAdapter(makeSource(`${origin}/movie/27205?sv=4k`));
  assert.ok(picked instanceof MoviesNexusPlayerAdapter, 'registry picks MoviesNexus adapter');
}

console.log('MoviesNexus provider integration tests passed: exact URLs (movie/TV, sv=4k & sv=multiaudio2), startAt resume with sv preserved, migration exposure limited to the two requested variants, PLAYER_PROGRESS → canonical timeupdate, origin/payload rejection, metadata events acknowledged, adapter registry wiring.');
