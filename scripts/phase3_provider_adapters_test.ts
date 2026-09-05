import assert from 'node:assert/strict';
import type { PlayerSource } from '$lib/shared/player';
import { PlaybackManager } from '$lib/client/player/PlaybackManager';
import { createDefaultAdapterRegistry, PlayerAdapterRegistry } from '$lib/client/player/adapter-registry';
import { DirectPlayerAdapter } from '$lib/client/player/direct-adapter';
import { EmbedPlayerAdapter } from '$lib/client/player/embed-adapter';
import { VidSrcPlayerAdapter } from '$lib/client/player/providers/vidsrc-adapter';
import { VidLinkPlayerAdapter } from '$lib/client/player/providers/vidlink-adapter';
import { VidYPlayerAdapter } from '$lib/client/player/providers/vidy-adapter';
import { VidukiPlayerAdapter } from '$lib/client/player/providers/viduki-adapter';
import { CineSrcPlayerAdapter } from '$lib/client/player/providers/cinesrc-adapter';
import { VidApiQzzPlayerAdapter } from '$lib/client/player/providers/vidapi-qzz-adapter';
import { CinemaOSPlayerAdapter } from '$lib/client/player/providers/cinemaos-adapter';
import { VidPhantomPlayerAdapter } from '$lib/client/player/providers/vidphantom-adapter';
import {
  VIDSRC_CAPABILITIES, VIDLINK_CAPABILITIES, VIDY_CAPABILITIES, VIDUKI_CAPABILITIES,
  CINESRC_CAPABILITIES, VIDAPI_QZZ_CAPABILITIES, CINEMAOS_CAPABILITIES, VIDPHANTOM_CAPABILITIES,
  DIRECT_PLAYBACK_CAPABILITIES, EMBED_PLAYBACK_CAPABILITIES,
} from '$lib/client/player/capabilities';
import type { PlayerEvent } from '$lib/client/player/events';

// --- Minimal window mock for postMessage testing in Node.js ---
//
// tsx (Node.js) has no `window` global. The provider adapters use
// `window.addEventListener('message', ...)` and `window.removeEventListener`.
// We install a minimal mock so the adapter's listener registration works
// and we can simulate postMessage events via `dispatchEvent`.

class MockMessageEvent {
  type: string;
  origin: string;
  data: unknown;
  constructor(type: string, init: { origin?: string; data?: unknown } = {}) {
    this.type = type;
    this.origin = init.origin ?? '';
    this.data = init.data;
  }
}

const messageListeners: Set<(event: { type: string; origin: string; data: unknown }) => void> = new Set();

const mockWindow = {
  addEventListener: (_type: string, listener: (event: { type: string; origin: string; data: unknown }) => void) => {
    if (_type === 'message') messageListeners.add(listener);
  },
  removeEventListener: (_type: string, listener: (event: { type: string; origin: string; data: unknown }) => void) => {
    if (_type === 'message') messageListeners.delete(listener);
  },
  dispatchEvent: (event: { type: string; origin: string; data: unknown }) => {
    for (const listener of messageListeners) {
      try { listener(event); } catch { /* listeners must never throw */ }
    }
    return true;
  },
  postMessage: (_data: unknown, _origin: string) => { /* no-op for tests */ },
};

// Install the mock globally BEFORE creating any adapter instances.
(globalThis as unknown as { window: typeof mockWindow; MessageEvent: typeof MockMessageEvent }).window = mockWindow;
(globalThis as unknown as { MessageEvent: typeof MockMessageEvent }).MessageEvent = MockMessageEvent;

// Phase 3: provider adapter contract tests.
//
// These tests verify that provider-specific adapters correctly:
//   1. Report VERIFIED capabilities (not invented).
//   2. Match by URL origin (canHandle).
//   3. Normalize documented postMessage events.
//   4. Ignore invalid messages, unrelated origins, and destroyed-adapter events.
//   5. Clean up listeners on destroy.
//   6. Support bidirectional commands (CineSrc only).
//
// Browser-only behavior (actual iframe rendering) is NOT tested here —
// only the adapter logic (origin validation, message parsing, event
// normalization, command forwarding) is unit-tested via simulated
// `window.postMessage` calls.

// --- Helpers ---

function makeSource(url: string, overrides: Partial<PlayerSource> = {}): PlayerSource {
  return {
    type: 'embed',
    url,
    providerId: '00000000-0000-4000-8000-000000000001',
    sourceId: '00000000-0000-4000-8000-000000000002',
    mediaType: 'movie',
    ...overrides,
  };
}

function makeDirectSource(url: string): PlayerSource {
  return makeSource(url, { type: 'direct' });
}

/**
 * Simulate a postMessage event from a provider iframe. Dispatches on the
 * mock window with the given origin and data.
 */
function simulateMessage(origin: string, data: unknown): void {
  const event = new MockMessageEvent('message', { origin, data });
  mockWindow.dispatchEvent(event);
}

/**
 * Collect events emitted by an adapter into an array.
 */
function collectEvents(adapter: { onEvent: (handler: (event: PlayerEvent) => void) => () => void }): PlayerEvent[] {
  const events: PlayerEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  return events;
}

// --- 1. Direct adapter reports correct capabilities ---

const directAdapter = new DirectPlayerAdapter();
const directCaps = directAdapter.getCapabilities();
assert.equal(directCaps.currentTime, true, 'direct: currentTime');
assert.equal(directCaps.duration, true, 'direct: duration');
assert.equal(directCaps.seek, true, 'direct: seek');
assert.equal(directCaps.play, true, 'direct: play');
assert.equal(directCaps.pause, true, 'direct: pause');
assert.equal(directCaps.postMessage, false, 'direct: no postMessage');

// --- 2. Embed adapter reports generic embed capabilities ---

const embedAdapter = new EmbedPlayerAdapter();
const embedCaps = embedAdapter.getCapabilities();
assert.equal(embedCaps.currentTime, false, 'embed: no currentTime (black box)');
assert.equal(embedCaps.postMessage, false, 'embed: no postMessage');
assert.equal(embedCaps.fullscreen, true, 'embed: fullscreen (allowfullscreen)');

// --- 3. Provider adapters match by URL origin ---

const vidsrcAdapter = new VidSrcPlayerAdapter();
assert.equal(vidsrcAdapter.canHandle(makeSource('https://vidsrc.wiki/embed/movie/550')), true);
assert.equal(vidsrcAdapter.canHandle(makeSource('https://vidlink.pro/movie/550')), false);
assert.equal(vidsrcAdapter.canHandle(makeSource('https://example.test/embed')), false);

const vidlinkAdapter = new VidLinkPlayerAdapter();
assert.equal(vidlinkAdapter.canHandle(makeSource('https://vidlink.pro/movie/550')), true);
assert.equal(vidlinkAdapter.canHandle(makeSource('https://vidsrc.wiki/embed/movie/550')), false);

const vidyAdapter = new VidYPlayerAdapter();
assert.equal(vidyAdapter.canHandle(makeSource('https://vidy.st/movie/550')), true);
assert.equal(vidyAdapter.canHandle(makeSource('https://www.vidy.st/movie/550')), true);
assert.equal(vidyAdapter.canHandle(makeSource('https://vidlink.pro/movie/550')), false);

const vidukiAdapter = new VidukiPlayerAdapter();
assert.equal(vidukiAdapter.canHandle(makeSource('https://www.viduki.net/1/movie/550')), true);
assert.equal(vidukiAdapter.canHandle(makeSource('https://vidlink.pro/movie/550')), false);

const cinesrcAdapter = new CineSrcPlayerAdapter();
assert.equal(cinesrcAdapter.canHandle(makeSource('https://cinesrc.st/embed/movie/550')), true);
assert.equal(cinesrcAdapter.canHandle(makeSource('https://vidlink.pro/movie/550')), false);

const vidapiQzzAdapter = new VidApiQzzPlayerAdapter();
assert.equal(vidapiQzzAdapter.canHandle(makeSource('https://vidapi.qzz.io/movie/550')), true);
assert.equal(vidapiQzzAdapter.canHandle(makeSource('https://vidlink.pro/movie/550')), false);

const cinemaosAdapter = new CinemaOSPlayerAdapter();
assert.equal(cinemaosAdapter.canHandle(makeSource('https://cinemaos.tech/player/550')), true);
assert.equal(cinemaosAdapter.canHandle(makeSource('https://vidlink.pro/movie/550')), false);

const vidphantomAdapter = new VidPhantomPlayerAdapter();
assert.equal(vidphantomAdapter.canHandle(makeSource('https://vidphantom.com/movie/550')), true);
assert.equal(vidphantomAdapter.canHandle(makeSource('https://vidlink.pro/movie/550')), false);

// --- 4. Direct adapter rejects embed sources, vice versa ---

assert.equal(directAdapter.canHandle(makeSource('https://example.test/embed')), false);
assert.equal(embedAdapter.canHandle(makeDirectSource('https://example.test/movie.mp4')), false);

// --- 5. VidSrc event normalization ---

const vidsrcEvents = collectEvents(vidsrcAdapter);
vidsrcAdapter.load({ source: makeSource('https://vidsrc.wiki/embed/movie/550') });

// Simulate VidSrc PLAYER_EVENT with player_status="playing" and player_progress=42.5
simulateMessage('https://vidsrc.wiki', {
  type: 'PLAYER_EVENT',
  data: { player_status: 'playing', player_progress: 42.5, player_duration: 7200 },
});
assert.ok(vidsrcEvents.some((e) => e.type === 'play'), 'VidSrc: play event normalized');
assert.ok(vidsrcEvents.some((e) => e.type === 'timeupdate' && e.currentTime === 42.5), 'VidSrc: timeupdate with currentTime=42.5');

// Simulate player_status="paused"
vidsrcEvents.length = 0;
simulateMessage('https://vidsrc.wiki', {
  type: 'PLAYER_EVENT',
  data: { player_status: 'paused', player_progress: 50 },
});
assert.ok(vidsrcEvents.some((e) => e.type === 'pause'), 'VidSrc: pause event normalized');

// Simulate player_status="completed"
vidsrcEvents.length = 0;
simulateMessage('https://vidsrc.wiki', {
  type: 'PLAYER_EVENT',
  data: { player_status: 'completed', player_progress: 7200, player_duration: 7200 },
});
assert.ok(vidsrcEvents.some((e) => e.type === 'ended'), 'VidSrc: ended event normalized');

vidsrcAdapter.destroy();

// --- 6. VidLink event normalization ---

const vidlinkEvents = collectEvents(vidlinkAdapter);
vidlinkAdapter.load({ source: makeSource('https://vidlink.pro/movie/550') });

simulateMessage('https://vidlink.pro', {
  type: 'PLAYER_EVENT',
  data: { event: 'timeupdate', currentTime: 120, duration: 5400 },
});
assert.ok(vidlinkEvents.some((e) => e.type === 'timeupdate' && e.currentTime === 120), 'VidLink: timeupdate with currentTime=120');

vidlinkEvents.length = 0;
simulateMessage('https://vidlink.pro', {
  type: 'PLAYER_EVENT',
  data: { event: 'play', currentTime: 120, duration: 5400 },
});
assert.ok(vidlinkEvents.some((e) => e.type === 'play'), 'VidLink: play event normalized');

vidlinkEvents.length = 0;
simulateMessage('https://vidlink.pro', {
  type: 'PLAYER_EVENT',
  data: { event: 'ended' },
});
assert.ok(vidlinkEvents.some((e) => e.type === 'ended'), 'VidLink: ended event normalized');

// MEDIA_DATA should NOT produce a normalized event
vidlinkEvents.length = 0;
simulateMessage('https://vidlink.pro', { type: 'MEDIA_DATA', data: 'some-serialized-data' });
assert.equal(vidlinkEvents.length, 0, 'VidLink: MEDIA_DATA does not emit a normalized event');

vidlinkAdapter.destroy();

// --- 7. VidY event normalization (JSON strings) ---

const vidyEvents = collectEvents(vidyAdapter);
vidyAdapter.load({ source: makeSource('https://vidy.st/movie/550') });

// VidY posts PLAYER_EVENT as a JSON STRING
simulateMessage('https://vidy.st', JSON.stringify({ event: 'timeupdate', currentTime: 60, duration: 3600 }));
assert.ok(vidyEvents.some((e) => e.type === 'timeupdate' && e.currentTime === 60), 'VidY: timeupdate from JSON string');

vidyEvents.length = 0;
simulateMessage('https://vidy.st', JSON.stringify({ event: 'play' }));
assert.ok(vidyEvents.some((e) => e.type === 'play'), 'VidY: play from JSON string');

vidyEvents.length = 0;
simulateMessage('https://vidy.st', JSON.stringify({ event: 'ended' }));
assert.ok(vidyEvents.some((e) => e.type === 'ended'), 'VidY: ended from JSON string');

vidyAdapter.destroy();

// --- 8. Viduki event normalization (all-servers-failed + MEDIA_DATA) ---

const vidukiEvents = collectEvents(vidukiAdapter);
vidukiAdapter.load({ source: makeSource('https://www.viduki.net/1/movie/550') });

// Simulate viduki:all-servers-failed
simulateMessage('https://www.viduki.net', {
  type: 'viduki:all-servers-failed',
  source: 'viduki-api-1',
  stage: 'initial',
  message: 'All servers failed',
});
assert.ok(vidukiEvents.some((e) => e.type === 'provider-error'), 'Viduki: all-servers-failed → provider-error');

// Simulate MEDIA_DATA with progress
vidukiEvents.length = 0;
simulateMessage('https://www.viduki.net', {
  type: 'MEDIA_DATA',
  data: { id: '550', type: 'movie', progress: { watched: 300, duration: 7200 } },
});
assert.ok(vidukiEvents.some((e) => e.type === 'timeupdate' && e.currentTime === 300), 'Viduki: MEDIA_DATA progress → timeupdate');

vidukiAdapter.destroy();

// --- 9. VidAPI.qzz.io event normalization (MEDIA_DATA only) ---

const vidapiEvents = collectEvents(vidapiQzzAdapter);
vidapiQzzAdapter.load({ source: makeSource('https://vidapi.qzz.io/movie/550') });

simulateMessage('https://vidapi.qzz.io', {
  type: 'MEDIA_DATA',
  data: { id: '550', type: 'movie', progress: { watched: 1194, duration: 6360, percentage: 18.7 } },
});
assert.ok(vidapiEvents.some((e) => e.type === 'timeupdate' && e.currentTime === 1194), 'VidAPI.qzz.io: MEDIA_DATA → timeupdate');

vidapiQzzAdapter.destroy();

// --- 10. CineSrc event normalization (full bidirectional) ---

const cinesrcEvents = collectEvents(cinesrcAdapter);
cinesrcAdapter.load({ source: makeSource('https://cinesrc.st/embed/movie/550') });

// cinesrc:ready
simulateMessage('https://cinesrc.st', { type: 'cinesrc:ready' });
assert.ok(cinesrcEvents.some((e) => e.type === 'ready'), 'CineSrc: ready event');

// cinesrc:play
cinesrcEvents.length = 0;
simulateMessage('https://cinesrc.st', { type: 'cinesrc:play' });
assert.ok(cinesrcEvents.some((e) => e.type === 'play'), 'CineSrc: play event');

// cinesrc:timeupdate {currentTime, duration}
cinesrcEvents.length = 0;
simulateMessage('https://cinesrc.st', { type: 'cinesrc:timeupdate', currentTime: 45.5, duration: 3600 });
assert.ok(cinesrcEvents.some((e) => e.type === 'timeupdate' && e.currentTime === 45.5), 'CineSrc: timeupdate');

// cinesrc:ended
cinesrcEvents.length = 0;
simulateMessage('https://cinesrc.st', { type: 'cinesrc:ended' });
assert.ok(cinesrcEvents.some((e) => e.type === 'ended'), 'CineSrc: ended event');

cinesrcAdapter.destroy();

// --- 11. Invalid message is ignored ---

const vidsrcEvents2 = collectEvents(vidsrcAdapter);
vidsrcAdapter.load({ source: makeSource('https://vidsrc.wiki/embed/movie/550') });

simulateMessage('https://vidsrc.wiki', { type: 'UNKNOWN_TYPE', data: {} });
simulateMessage('https://vidsrc.wiki', null);
simulateMessage('https://vidsrc.wiki', 'not-json');
simulateMessage('https://vidsrc.wiki', 42);
assert.equal(vidsrcEvents2.length, 0, 'VidSrc: invalid messages are silently dropped');

vidsrcAdapter.destroy();

// --- 12. Unrelated window message is ignored (wrong origin) ---

const vidsrcEvents3 = collectEvents(vidsrcAdapter);
vidsrcAdapter.load({ source: makeSource('https://vidsrc.wiki/embed/movie/550') });

simulateMessage('https://evil.example.test', {
  type: 'PLAYER_EVENT',
  data: { player_status: 'playing', player_progress: 999 },
});
assert.equal(vidsrcEvents3.length, 0, 'VidSrc: messages from wrong origin are dropped');

vidsrcAdapter.destroy();

// --- 13. Destroy stops provider messages from affecting state ---

const vidsrcEvents4 = collectEvents(vidsrcAdapter);
vidsrcAdapter.load({ source: makeSource('https://vidsrc.wiki/embed/movie/550') });
vidsrcAdapter.destroy();

simulateMessage('https://vidsrc.wiki', {
  type: 'PLAYER_EVENT',
  data: { player_status: 'playing', player_progress: 42 },
});
assert.equal(vidsrcEvents4.length, 0, 'VidSrc: events after destroy are dropped');

// --- 14. CineSrc capabilities are the only VERIFIED bidirectional set ---

assert.equal(CINESRC_CAPABILITIES.play, true, 'CineSrc: play command VERIFIED');
assert.equal(CINESRC_CAPABILITIES.pause, true, 'CineSrc: pause command VERIFIED');
assert.equal(CINESRC_CAPABILITIES.seek, true, 'CineSrc: seek command VERIFIED');
assert.equal(CINESRC_CAPABILITIES.volume, true, 'CineSrc: volume command VERIFIED');

// All other providers have play/pause/seek = false (events only, no commands)
assert.equal(VIDSRC_CAPABILITIES.play, false, 'VidSrc: play command NOT verified (events only)');
assert.equal(VIDSRC_CAPABILITIES.seek, false, 'VidSrc: seek command NOT verified');
assert.equal(VIDLINK_CAPABILITIES.play, false, 'VidLink: play command NOT verified');
assert.equal(VIDY_CAPABILITIES.play, false, 'VidY: play command NOT verified');
assert.equal(VIDUKI_CAPABILITIES.play, false, 'Viduki: play command NOT verified');
assert.equal(VIDAPI_QZZ_CAPABILITIES.play, false, 'VidAPI.qzz.io: play command NOT verified');

// --- 15. Capability-aware command forwarding via PlaybackManager ---

// CineSrc adapter supports play/pause/seek; verify the manager forwards
// commands to the adapter.
const manager = new PlaybackManager({
  fetcher: async () => new Response(JSON.stringify({
    ok: true,
    source: { type: 'embed', url: 'https://cinesrc.st/embed/movie/550', providerId: 'p', sourceId: 's', mediaType: 'movie' },
  }), { status: 200, headers: { 'content-type': 'application/json' } }) as unknown as Response,
});
await manager.loadSource({ sourceId: 's', contentId: '550', mediaType: 'movie' }, 0, true);

// Manager should report CineSrc capabilities.
const caps = manager.getActiveCapabilities();
assert.equal(caps.play, true, 'Manager: active adapter supports play');
assert.equal(caps.seek, true, 'Manager: active adapter supports seek');

// Manager should forward play command to CineSrc adapter (which posts a
// cinesrc:command message). The command resolves ok because the adapter
// successfully posts the message (the actual provider response is async
// and not awaited for non-getter commands).
const playResult = await manager.play();
assert.equal(playResult.ok, true, 'Manager: play command forwarded to CineSrc');

// Seek command
const seekResult = await manager.seek(120);
assert.equal(seekResult.ok, true, 'Manager: seek command forwarded to CineSrc');

manager.dispose();

// --- 16. Unsupported seek returns unsupported (not fake success) ---

// VidLink adapter does NOT support seek — the manager should return
// { ok: false, reason: 'unsupported' } without calling the adapter.
const manager2 = new PlaybackManager({
  fetcher: async () => new Response(JSON.stringify({
    ok: true,
    source: { type: 'embed', url: 'https://vidlink.pro/movie/550', providerId: 'p', sourceId: 's', mediaType: 'movie' },
  }), { status: 200, headers: { 'content-type': 'application/json' } }) as unknown as Response,
});
await manager2.loadSource({ sourceId: 's', contentId: '550', mediaType: 'movie' }, 0, true);

const caps2 = manager2.getActiveCapabilities();
assert.equal(caps2.seek, false, 'VidLink: seek NOT supported');

const seekResult2 = await manager2.seek(120);
assert.equal(seekResult2.ok, false, 'VidLink: seek returns ok=false');
assert.equal(seekResult2.reason, 'unsupported', 'VidLink: seek returns reason=unsupported');

const playResult2 = await manager2.play();
assert.equal(playResult2.ok, false, 'VidLink: play returns ok=false (no command support)');
assert.equal(playResult2.reason, 'unsupported', 'VidLink: play returns reason=unsupported');

manager2.dispose();

// --- 17. Default registry has provider adapters registered before generic embed ---

const registry = createDefaultAdapterRegistry();
const list = registry.list();
assert.ok(list.length >= 10, `default registry has ${list.length} adapters (expected >=10)`);

// Direct is first
assert.ok(list[0] instanceof DirectPlayerAdapter, 'registry[0] = DirectPlayerAdapter');

// Generic embed is LAST (fallback)
assert.ok(list[list.length - 1] instanceof EmbedPlayerAdapter, 'registry[last] = EmbedPlayerAdapter');

// Provider-specific adapters are between direct and generic embed
const providerAdapters = list.slice(1, -1);
assert.ok(providerAdapters.some((a) => a instanceof CineSrcPlayerAdapter), 'registry includes CineSrc adapter');
assert.ok(providerAdapters.some((a) => a instanceof VidSrcPlayerAdapter), 'registry includes VidSrc adapter');
assert.ok(providerAdapters.some((a) => a instanceof VidLinkPlayerAdapter), 'registry includes VidLink adapter');
assert.ok(providerAdapters.some((a) => a instanceof VidYPlayerAdapter), 'registry includes VidY adapter');
assert.ok(providerAdapters.some((a) => a instanceof VidukiPlayerAdapter), 'registry includes Viduki adapter');
assert.ok(providerAdapters.some((a) => a instanceof VidApiQzzPlayerAdapter), 'registry includes VidAPI.qzz.io adapter');

// --- 18. pickAdapter selects the correct provider adapter by URL origin ---

assert.ok(registry.pickAdapter(makeSource('https://cinesrc.st/embed/movie/550')) instanceof CineSrcPlayerAdapter);
assert.ok(registry.pickAdapter(makeSource('https://vidsrc.wiki/embed/movie/550')) instanceof VidSrcPlayerAdapter);
assert.ok(registry.pickAdapter(makeSource('https://vidlink.pro/movie/550')) instanceof VidLinkPlayerAdapter);
assert.ok(registry.pickAdapter(makeSource('https://vidy.st/movie/550')) instanceof VidYPlayerAdapter);
assert.ok(registry.pickAdapter(makeSource('https://www.viduki.net/1/movie/550')) instanceof VidukiPlayerAdapter);
assert.ok(registry.pickAdapter(makeSource('https://vidapi.qzz.io/movie/550')) instanceof VidApiQzzPlayerAdapter);
assert.ok(registry.pickAdapter(makeSource('https://cinemaos.tech/player/550')) instanceof CinemaOSPlayerAdapter);
assert.ok(registry.pickAdapter(makeSource('https://vidphantom.com/movie/550')) instanceof VidPhantomPlayerAdapter);

// Unknown origin → generic embed adapter
assert.ok(registry.pickAdapter(makeSource('https://unknown-provider.example.test/movie/550')) instanceof EmbedPlayerAdapter);

// Direct source → DirectPlayerAdapter
assert.ok(registry.pickAdapter(makeDirectSource('https://example.test/movie.mp4')) instanceof DirectPlayerAdapter);

// --- 19. CinemaOS and VidPhantom skeleton adapters are conservative ---

assert.equal(CINEMAOS_CAPABILITIES.currentTime, false, 'CinemaOS: currentTime NOT verified (JS-rendered docs)');
assert.equal(CINEMAOS_CAPABILITIES.postMessage, true, 'CinemaOS: postMessage API exists');
assert.equal(CINEMAOS_CAPABILITIES.nextEpisode, true, 'CinemaOS: autoNext param documented');
assert.equal(CINEMAOS_CAPABILITIES.fullscreen, true, 'CinemaOS: fullscreen documented');

assert.equal(VIDPHANTOM_CAPABILITIES.currentTime, false, 'VidPhantom: currentTime NOT verified (origin 522)');
assert.equal(VIDPHANTOM_CAPABILITIES.postMessage, true, 'VidPhantom: postMessage API exists (snippet)');
assert.equal(VIDPHANTOM_CAPABILITIES.play, false, 'VidPhantom: play NOT verified');

// --- 20. Phase 1 manager behavior intact (regression) ---

const manager3 = new PlaybackManager({
  fetcher: async () => new Response(JSON.stringify({
    ok: true,
    source: { type: 'embed', url: 'https://example.test/embed/movie/550', providerId: 'p', sourceId: 's', mediaType: 'movie' },
  }), { status: 200, headers: { 'content-type': 'application/json' } }) as unknown as Response,
});
assert.equal(manager3.getSource(), null, 'initial source null');
await manager3.loadSource({ sourceId: 's', contentId: '550', mediaType: 'movie' }, 0, true);
assert.equal(manager3.getSource()?.sourceId, 's', 'loadSource works');
manager3.dispose();

console.log('Phase 3 provider adapter tests passed: direct/embed capabilities, provider origin matching (8 providers), VidSrc/VidLink/VidY/Viduki/VidAPI.qzz.io/CineSrc event normalization, CineSrc bidirectional commands, invalid message handling, wrong-origin rejection, post-destroy event drop, CineSrc-only bidirectional capability verification, capability-aware command forwarding (supported seek reaches adapter, unsupported seek returns unsupported), default registry order (provider adapters before generic embed), pickAdapter by origin, CinemaOS/VidPhantom skeleton conservative capabilities, Phase 1 manager regression intact.');
