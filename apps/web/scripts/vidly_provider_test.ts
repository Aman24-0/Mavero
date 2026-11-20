import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { createDefaultAdapters } from '$lib/server/resolver/adapters';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { TrustedResolutionConfig } from '$lib/server/resolver/types';
import type { PlayerSource } from '$lib/shared/player';
import { createDefaultAdapterRegistry } from '$lib/client/player/adapter-registry';
import { VidlyPlayerAdapter } from '$lib/client/player/providers/vidly-adapter';
import { VIDLY_CAPABILITIES, PROVIDER_CAPABILITY_MAP } from '$lib/client/player/capabilities';
import type { PlayerEvent } from '$lib/client/player/events';

// Vidly provider integration tests (2026-11-17 integration).
//
// Contract source: the provider's own documentation (https://vidly.pro/),
// read 2026-11-17. DOCS-LEVEL — end-to-end playback in a Mavero browser
// session is NOT yet verified, so the source is seeded experimental and
// disabled, and every assertion below is against the DOCUMENTED contract:
//   Movie: https://vidly.pro/movie/{tmdbId}
//   TV:    https://vidly.pro/tv/{tmdbId}/{season}/{episode}
//   ?t=N (resume seconds, appended by the PlaybackManager),
//   ?color=<hex without #> (accent, injected client-side),
//   theme/autoplay/nextEpisode/audioPicker keep their documented defaults.
//   postMessage (origin https://vidly.pro):
//     VIDLY_PLAYER_EVENT {data:{event:'play'|'pause'|'timeupdate'|'ended',
//       currentTime, duration, ...}}; SYNC_HISTORY (not normalized — the
//       documented `watched` unit is unspecified).

const providerId = '00000000-0000-4000-8000-00000000vly1';
const EMBED_ORIGIN = 'https://vidly.pro';

// Mirrors migration 20261126000000_vidly_provider.sql exactly.
const capabilities = {
  movie: true, series: true, anime: false,
  result_type: 'embed', supports_episode: true, supports_direct: false,
  supports_server_selection: true, automatic_server_fallback: false,
  supports_subtitles: true, supports_language_selection: false, supports_download: false,
  allow_experimental_playback: true,
  sandbox_policy: 'required',
  allowed_embed_origins: [EMBED_ORIGIN],
};
// The ENABLED state (what an admin gets after flipping status→active and
// enabled→true). The migration's seeded DISABLED state is asserted
// separately below — see "seeded state" checks.
const config: TrustedResolutionConfig = {
  provider: { id: providerId, name: 'Vidly', status: 'experimental', enabled: true, integration_type: 'embed', adapter_id: 'vidly', capabilities },
  source: {
    id: 's1', provider_id: providerId, name: 'Vidly',
    status: 'active', enabled: true, visibility: 'public', integration_type: 'embed',
    capabilities,
    movie_template: `${EMBED_ORIGIN}/movie/{tmdb_id}`,
    series_template: `${EMBED_ORIGIN}/tv/{tmdb_id}/{season}/{episode}`,
    anime_template: null, identifier_mode: 'tmdb_id',
    audio_languages: ['multi'], subtitle_capability: true, quality_capability: [],
  },
};

const adapters = createDefaultAdapters();

function content(type: 'movie' | 'series', tmdb: string): NormalizedMediaItem {
  return {
    id: tmdb, title: 'Fixture', year: 2024, type, runtime: '120 min', rating: 8,
    genres: ['Drama'], description: 'Fixture',
    poster: 'https://image.example.test/poster.jpg', backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#ffffff',
    source: { provider: 'tmdb', externalId: tmdb, fetchedAt: new Date().toISOString() },
    externalIds: { tmdb },
  };
}

// --- URL building (server-side resolver) ---

// Movie 1010581 (the provider's own documented example) → clean template URL.
const movie = await resolveSourceFromConfig(
  { sourceId: 's1', contentId: '1010581', mediaType: 'movie' },
  config, content('movie', '1010581'), { adapters },
);
assert.equal(movie.type, 'embed');
assert.equal(movie.url, 'https://vidly.pro/movie/1010581', 'movie template: no params baked in (color/t are client-side)');

// TV 1399 S2E5 → season/episode in the path, never 1/1.
const tv = await resolveSourceFromConfig(
  { sourceId: 's1', contentId: '1399', mediaType: 'series', season: 2, episode: 5 },
  config, content('series', '1399'), { adapters },
);
assert.equal(tv.url, 'https://vidly.pro/tv/1399/2/5');
assert.ok(tv.url.includes('/tv/1399/2/5'), 'season=2 episode=5 in path (never 1/1)');

// Seeded state: the migration ships the source DISABLED and experimental —
// the resolver must refuse it (nothing plays until an admin enables it).
const seededConfig: TrustedResolutionConfig = {
  ...config,
  source: { ...config.source, status: 'experimental', enabled: false },
};
let seededDisabled = false;
try {
  await resolveSourceFromConfig(
    { sourceId: 's1', contentId: '1010581', mediaType: 'movie' },
    seededConfig, content('movie', '1010581'), { adapters },
  );
} catch (error) {
  seededDisabled = (error as { code?: string }).code === 'SOURCE_DISABLED';
}
assert.ok(seededDisabled, 'seeded (disabled) source is refused by the resolver — SOURCE_DISABLED');

// The experimental trial path: source ENABLED but still status
// 'experimental' resolves because allow_experimental_playback=true — this
// is exactly what an admin gets from System -> API & Sources before the
// source is promoted to 'active'.
const trialConfig: TrustedResolutionConfig = {
  ...config,
  source: { ...config.source, status: 'experimental', enabled: true },
};
const trial = await resolveSourceFromConfig(
  { sourceId: 's1', contentId: '1010581', mediaType: 'movie' },
  trialConfig, content('movie', '1010581'), { adapters },
);
assert.equal(trial.url, 'https://vidly.pro/movie/1010581', 'enabled experimental source resolves via allow_experimental_playback');

// Without the experimental flag, an experimental source must NOT resolve.
const noFlagConfig: TrustedResolutionConfig = {
  ...trialConfig,
  // Provider promoted to 'active' so the SOURCE gate is what gets tested
  // (an experimental provider without the flag fails earlier, with
  // PROVIDER_DISABLED).
  provider: { ...trialConfig.provider, status: 'active', capabilities: { ...capabilities, allow_experimental_playback: false } },
  source: { ...trialConfig.source, capabilities: { ...capabilities, allow_experimental_playback: false } },
};
let noFlagRejected = false;
try {
  await resolveSourceFromConfig(
    { sourceId: 's1', contentId: '1010581', mediaType: 'movie' },
    noFlagConfig, content('movie', '1010581'), { adapters },
  );
} catch (error) {
  noFlagRejected = (error as { code?: string }).code === 'SOURCE_MAINTENANCE';
}
assert.ok(noFlagRejected, 'experimental source without the flag is gated (SOURCE_MAINTENANCE)');

// A series request without season/episode must NOT silently produce /tv/{id}/undefined.
let missingEpisodeThrew = false;
try {
  await resolveSourceFromConfig(
    { sourceId: 's1', contentId: '1399', mediaType: 'series' },
    config, content('series', '1399'), { adapters },
  );
} catch {
  missingEpisodeThrew = true;
}
assert.ok(missingEpisodeThrew, 'series resolution without season/episode fails closed (MISSING_IDENTIFIER)');

// The documented origin is the ONLY allowlisted embed origin.
const wrongOriginConfig: TrustedResolutionConfig = {
  ...config,
  source: { ...config.source, movie_template: 'https://vidly.pro.evil.example.com/movie/{tmdb_id}' },
};
let wrongOriginRejected = false;
try {
  await resolveSourceFromConfig(
    { sourceId: 's1', contentId: '1010581', mediaType: 'movie' },
    wrongOriginConfig, content('movie', '1010581'), { adapters },
  );
} catch {
  wrongOriginRejected = true;
}
assert.ok(wrongOriginRejected, 'embed URL outside allowed_embed_origins is rejected');

// Sandbox: provider-level policy is required (the documented default).
assert.equal(movie.sandboxPolicy, 'required');

// --- Migration content assertions ---

const migrationPath = 'supabase/migrations/20261126000000_vidly_provider.sql';
const migration = readFileSync(resolve(migrationPath), 'utf-8');
assert.ok(migration.includes('https://vidly.pro/movie/{tmdb_id}'), 'migration: movie template');
assert.ok(migration.includes('https://vidly.pro/tv/{tmdb_id}/{season}/{episode}'), 'migration: series template');
assert.ok(migration.includes("jsonb_build_array('https://vidly.pro')"), 'migration: allowed embed origin');
assert.ok(migration.includes("'tmdb_id'"), 'migration: identifier mode tmdb_id');
assert.ok(migration.includes("'vidly'"), 'migration: provider slug + adapter_id');
assert.ok(migration.includes('440'), 'migration: ordering 440 (behind the verified band)');
// One provider, one source — Vidly's internal servers are NOT Mavero sources.
assert.equal((migration.match(/insert into public\.streaming_providers/gi) ?? []).length, 1, 'migration: exactly ONE provider insert');
assert.equal((migration.match(/insert into public\.streaming_sources/gi) ?? []).length, 1, 'migration: exactly ONE source insert');
// Idempotent + non-destructive.
assert.equal((migration.match(/on conflict \(slug\) do nothing/gi) ?? []).length, 1, 'migration: provider insert idempotent');
assert.equal((migration.match(/on conflict \(provider_id, slug\) do nothing/gi) ?? []).length, 1, 'migration: source insert idempotent');
const migrationNoComments = migration.replace(/--.*$/gm, '');
assert.ok(!/\b(delete|alter|drop|truncate)\b/i.test(migrationNoComments), 'migration: no DELETE/ALTER/DROP/TRUNCATE');
assert.ok(!/\bupdate\b/i.test(migrationNoComments), 'migration: never updates an existing provider/source');
// Seeded safely: experimental + disabled, but trial-enablable by an admin.
assert.ok(migration.includes("'experimental'"), 'migration: seeded experimental');
assert.ok(migration.includes("'allow_experimental_playback', true"), 'migration: admin can trial-enable without further SQL');

// --- Adapter contract (window/document/getComputedStyle mocks) ---

class MockMessageEvent {
  type: string; origin: string; data: unknown; source: unknown;
  constructor(type: string, init: { origin?: string; data?: unknown; source?: unknown } = {}) {
    this.type = type; this.origin = init.origin ?? ''; this.data = init.data; this.source = init.source ?? null;
  }
}
const messageListeners = new Set<(event: { type: string; origin: string; data: unknown }) => void>();
let accentTokenValue = '#f97316'; // canonical Mavero --color-primary value
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

function simulateMessage(origin: string, data: unknown, source?: unknown): void {
  mockWindow.dispatchEvent(new MockMessageEvent('message', { origin, data, source }));
}
function makeSource(url: string): PlayerSource {
  return { type: 'embed', url, providerId, sourceId: 's1', mediaType: 'movie' };
}

const adapter = new VidlyPlayerAdapter();
const events: PlayerEvent[] = [];
adapter.load({ source: makeSource('https://vidly.pro/movie/1010581') });
adapter.onEvent((e) => events.push(e));

assert.deepEqual(adapter.getCapabilities(), VIDLY_CAPABILITIES);
assert.equal(PROVIDER_CAPABILITY_MAP['vidly'], VIDLY_CAPABILITIES, 'capability map registers vidly');
assert.equal(adapter.startAtParam(), 't', 'resume parameter is the documented t (seconds)');

// No command protocol is documented → no command methods exposed.
assert.equal(adapter.play, undefined, 'no play command (undocumented)');
assert.equal(adapter.pause, undefined, 'no pause command (undocumented)');
assert.equal(adapter.seek, undefined, 'no seek command (undocumented)');
assert.equal(adapter.setVolume, undefined, 'no volume command (undocumented)');

// canHandle: the documented origin only.
assert.ok(adapter.canHandle(makeSource('https://vidly.pro/movie/1010581')), 'canHandle vidly.pro movie embed');
assert.ok(adapter.canHandle(makeSource('https://vidly.pro/tv/1399/2/5')), 'canHandle vidly.pro tv embed');
assert.ok(!adapter.canHandle(makeSource('https://vidly.pro.evil.example.com/movie/1010581')), 'rejects lookalike host (suffix spoof)');
assert.ok(!adapter.canHandle(makeSource('https://evil.example.com/?u=https://vidly.pro/movie/1')), 'rejects unrelated host');
assert.ok(!adapter.canHandle(makeSource('https://vidstuck.cc/embed/movie/299534')), 'rejects other providers');
assert.ok(!adapter.canHandle({ ...makeSource('https://vidly.pro/movie/1'), type: 'direct' }), 'rejects non-embed sources');

// Registry: Vidly is picked for a vidly.pro embed (and the generic adapter
// is NOT), while other providers keep their own adapters.
const registry = createDefaultAdapterRegistry();
assert.equal(registry.pickAdapter(makeSource('https://vidly.pro/movie/1010581'))?.constructor.name, 'VidlyPlayerAdapter');
assert.equal(registry.pickAdapter(makeSource('https://vidstuck.cc/embed/movie/299534'))?.constructor.name, 'VidStuckPlayerAdapter');
const ids = registry.list().map((a) => a.constructor.name);
assert.ok(ids.indexOf('VidlyPlayerAdapter') < ids.indexOf('EmbedPlayerAdapter'), 'Vidly registered BEFORE the generic embed fallback');

// Dynamic accent: the documented color= parameter, hex WITHOUT '#'.
const finalized = adapter.finalizeEmbedUrl('https://vidly.pro/movie/1010581');
assert.ok(finalized, 'finalizeEmbedUrl returns a URL');
const finalizedUrl = new URL(finalized as string);
assert.equal(finalizedUrl.origin, EMBED_ORIGIN, 'finalizeEmbedUrl never changes the origin');
assert.equal(finalizedUrl.searchParams.get('color'), 'f97316', 'accent injected from the Mavero theme token, no #');
assert.equal(finalizedUrl.pathname, '/movie/1010581', 'path preserved');

// An unusable token leaves the URL untouched (null → caller keeps the URL).
accentTokenValue = 'not-a-color';
assert.equal(adapter.finalizeEmbedUrl('https://vidly.pro/movie/1010581'), null, 'invalid theme token → no rewrite');
accentTokenValue = '#f97316';

// --- Documented postMessage events ---

events.length = 0;
simulateMessage(EMBED_ORIGIN, { type: 'VIDLY_PLAYER_EVENT', data: { event: 'play', currentTime: 0, duration: 7557, tmdbId: '1726', mediaType: 'movie' } });
assert.deepEqual(events, [{ type: 'play' }], 'play → canonical play');

events.length = 0;
simulateMessage(EMBED_ORIGIN, { type: 'VIDLY_PLAYER_EVENT', data: { event: 'pause', currentTime: 42, duration: 7557 } });
assert.deepEqual(events, [{ type: 'pause' }], 'pause → canonical pause');

events.length = 0;
simulateMessage(EMBED_ORIGIN, { type: 'VIDLY_PLAYER_EVENT', data: { event: 'timeupdate', currentTime: 312.4, duration: 7557, tmdbId: '1726', mediaType: 'movie', season: null, episode: null } });
assert.deepEqual(events, [{ type: 'timeupdate', currentTime: 312.4, duration: 7557 }], 'documented timeupdate → canonical progress event');

events.length = 0;
simulateMessage(EMBED_ORIGIN, { type: 'VIDLY_PLAYER_EVENT', data: { event: 'ended', currentTime: 7557, duration: 7557 } });
assert.deepEqual(events, [{ type: 'ended' }], 'ended → canonical ended (explicit, never fabricated)');

// timeupdate without a usable currentTime is dropped (never guessed).
for (const bad of [
  { event: 'timeupdate' },
  { event: 'timeupdate', currentTime: Number.NaN, duration: 100 },
  { event: 'timeupdate', currentTime: -3, duration: 100 },
  { event: 'timeupdate', currentTime: '312.4', duration: 100 },
]) {
  events.length = 0;
  simulateMessage(EMBED_ORIGIN, { type: 'VIDLY_PLAYER_EVENT', data: bad });
  assert.equal(events.length, 0, `dropped unusable timeupdate: ${JSON.stringify(bad)}`);
}

// SYNC_HISTORY is deliberately NOT normalized (undocumented `watched` unit).
events.length = 0;
simulateMessage(EMBED_ORIGIN, { type: 'SYNC_HISTORY', data: { media_id: '1726', media_type: 'movie', title: 'Fixture', duration: 7557, watched: 312 } });
assert.equal(events.length, 0, 'SYNC_HISTORY is not normalized into a progress event');

// Unknown event names / malformed payloads are dropped, never thrown.
for (const bad of [
  { type: 'VIDLY_PLAYER_EVENT' },
  { type: 'VIDLY_PLAYER_EVENT', data: null },
  { type: 'VIDLY_PLAYER_EVENT', data: 'x' },
  { type: 'VIDLY_PLAYER_EVENT', data: { event: 'buffering' } },
  { type: 'VIDLY_PLAYER_EVENT', data: { event: 42 } },
  { type: 'SOMETHING_ELSE', data: { event: 'play' } },
  'not-json',
  null,
]) {
  events.length = 0;
  simulateMessage(EMBED_ORIGIN, bad);
  assert.equal(events.length, 0, `dropped malformed message: ${JSON.stringify(bad)}`);
}

// Origin is the primary security boundary.
for (const badOrigin of ['https://evil.example.com', 'http://vidly.pro', 'https://vidly.pro.evil.example.com', 'https://vidstuck.cc', '']) {
  events.length = 0;
  simulateMessage(badOrigin, { type: 'VIDLY_PLAYER_EVENT', data: { event: 'timeupdate', currentTime: 5, duration: 100 } });
  assert.equal(events.length, 0, `message origin rejected: ${badOrigin || '(empty)'}`);
}

// event.source defense-in-depth: only the ACTIVE embed iframe is accepted.
{
  const { setActiveIframeWindowResolver } = await import('$lib/client/player/providers/post-message-utils');
  const fakeActiveWindow = { postMessage: () => {} } as unknown as Window;
  const staleWindow = { postMessage: () => {} } as unknown as Window;
  setActiveIframeWindowResolver(() => fakeActiveWindow);
  try {
    events.length = 0;
    mockWindow.dispatchEvent(new MockMessageEvent('message', { origin: EMBED_ORIGIN, source: fakeActiveWindow, data: { type: 'VIDLY_PLAYER_EVENT', data: { event: 'timeupdate', currentTime: 7, duration: 100 } } }));
    assert.equal(events.length, 1, 'message from the ACTIVE iframe window is accepted');

    events.length = 0;
    mockWindow.dispatchEvent(new MockMessageEvent('message', { origin: EMBED_ORIGIN, source: staleWindow, data: { type: 'VIDLY_PLAYER_EVENT', data: { event: 'timeupdate', currentTime: 8, duration: 100 } } }));
    assert.equal(events.length, 0, 'message from a stale same-origin window is dropped');

    events.length = 0;
    mockWindow.dispatchEvent(new MockMessageEvent('message', { origin: EMBED_ORIGIN, data: { type: 'VIDLY_PLAYER_EVENT', data: { event: 'timeupdate', currentTime: 9, duration: 100 } } }));
    assert.equal(events.length, 0, 'message without a window source is dropped while an iframe is bound');

    setActiveIframeWindowResolver(null);
    events.length = 0;
    simulateMessage(EMBED_ORIGIN, { type: 'VIDLY_PLAYER_EVENT', data: { event: 'timeupdate', currentTime: 10, duration: 100 } });
    assert.equal(events.length, 1, 'without a bound iframe the origin check alone governs');
  } finally {
    setActiveIframeWindowResolver(null);
  }
}

// destroy() removes the listener: no event may reach the handler afterwards.
adapter.destroy();
events.length = 0;
simulateMessage(EMBED_ORIGIN, { type: 'VIDLY_PLAYER_EVENT', data: { event: 'timeupdate', currentTime: 11, duration: 100 } });
assert.equal(events.length, 0, 'no events after destroy()');

console.log('vidly_provider_test: all assertions passed');
