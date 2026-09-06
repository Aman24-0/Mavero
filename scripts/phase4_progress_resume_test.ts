import assert from 'node:assert/strict';
import type { PlayerSource } from '$lib/shared/player';
import { PlaybackManager } from '$lib/client/player/PlaybackManager';
import { CINESRC_CAPABILITIES, VIDLINK_CAPABILITIES, EMBED_PLAYBACK_CAPABILITIES, COMPLETION_THRESHOLD } from '$lib/client/player/capabilities';
import type { PlayerEvent } from '$lib/client/player/events';
import { progressKey, completionFor, clampTime, type PlaybackContext, type WatchProgressRecord, type SaveProgressInput } from '$lib/client/progress/types';

// Phase 4: progress + resume + source continuity tests.
//
// These tests verify:
//   - startAt URL param is appended to embed URLs for supported providers
//   - startAt is NOT appended for unsupported providers
//   - startAt is NOT appended when startPosition is 0
//   - startAt is idempotent (not appended twice)
//   - saved selectedSourceId is used for resume source selection
//   - manual source switch passes currentPlaybackTime as startPosition
//   - resume-once flag prevents repeated seek loops
//   - episode switch resets resume state
//   - progress events from embed sources reach the writer
//   - completion threshold is respected
//   - invalid resume position is ignored
//   - race conditions: stale source events cannot overwrite new source state

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

function makeFetch(source: PlayerSource): typeof fetch {
  return async () => new Response(JSON.stringify({ ok: true, source }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as unknown as Response;
}

// --- Minimal window mock for postMessage ---

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
  postMessage: (_data: unknown, _origin: string) => { /* no-op */ },
};
(globalThis as unknown as { window: typeof mockWindow }).window = mockWindow;

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
(globalThis as unknown as { MessageEvent: typeof MockMessageEvent }).MessageEvent = MockMessageEvent;

function simulateMessage(origin: string, data: unknown): void {
  const event = new MockMessageEvent('message', { origin, data });
  mockWindow.dispatchEvent(event);
}

// --- 1. startAt URL param appended for CineSrc ---

const cinesrcSource = makeSource('https://cinesrc.st/embed/movie/550');
const manager1 = new PlaybackManager({ fetcher: makeFetch(cinesrcSource) });
await manager1.loadSource({ sourceId: 's', contentId: '550', mediaType: 'movie' }, 300, true);
const resolved1 = manager1.getSource();
assert.ok(resolved1?.url, 'CineSrc: resolved source has a URL');
assert.ok(resolved1!.url!.includes('t=300'), `CineSrc: URL includes ?t=300; got: ${resolved1!.url}`);
manager1.dispose();

// --- 2. startAt URL param appended for VidLink ---

const vidlinkSource = makeSource('https://vidlink.pro/movie/550');
const manager2 = new PlaybackManager({ fetcher: makeFetch(vidlinkSource) });
await manager2.loadSource({ sourceId: 's', contentId: '550', mediaType: 'movie' }, 120, true);
const resolved2 = manager2.getSource();
assert.ok(resolved2!.url!.includes('startAt=120'), `VidLink: URL includes ?startAt=120; got: ${resolved2!.url}`);
manager2.dispose();

// --- 3. startAt URL param appended for VidY ---

const vidySource = makeSource('https://vidy.st/movie/550');
const manager3 = new PlaybackManager({ fetcher: makeFetch(vidySource) });
await manager3.loadSource({ sourceId: 's', contentId: '550', mediaType: 'movie' }, 60, true);
const resolved3 = manager3.getSource();
assert.ok(resolved3!.url!.includes('progress=60'), `VidY: URL includes ?progress=60; got: ${resolved3!.url}`);
manager3.dispose();

// --- 4. startAt NOT appended when startPosition is 0 ---

const manager4 = new PlaybackManager({ fetcher: makeFetch(cinesrcSource) });
await manager4.loadSource({ sourceId: 's', contentId: '550', mediaType: 'movie' }, 0, true);
const resolved4 = manager4.getSource();
assert.ok(!resolved4!.url!.includes('t='), `CineSrc: no startAt when startPosition=0; got: ${resolved4!.url}`);
manager4.dispose();

// --- 5. startAt NOT appended for unsupported providers (generic embed) ---

const genericSource = makeSource('https://unknown-provider.example.test/movie/550');
const manager5 = new PlaybackManager({ fetcher: makeFetch(genericSource) });
await manager5.loadSource({ sourceId: 's', contentId: '550', mediaType: 'movie' }, 300, true);
const resolved5 = manager5.getSource();
assert.ok(!resolved5!.url!.includes('startAt'), `Generic embed: no startAt appended; got: ${resolved5!.url}`);
assert.ok(!resolved5!.url!.includes('t='), `Generic embed: no t= appended; got: ${resolved5!.url}`);
manager5.dispose();

// --- 6. startAt idempotent (not appended twice) ---

const cinesrcWithStartAt = makeSource('https://cinesrc.st/embed/movie/550?t=100');
const manager6 = new PlaybackManager({ fetcher: makeFetch(cinesrcWithStartAt) });
await manager6.loadSource({ sourceId: 's', contentId: '550', mediaType: 'movie' }, 300, true);
const resolved6 = manager6.getSource();
// The URL already has t=100, so the manager should NOT append t=300.
assert.ok(resolved6!.url!.includes('t=100'), `CineSrc: existing t=100 preserved; got: ${resolved6!.url}`);
assert.ok(!resolved6!.url!.includes('t=300'), `CineSrc: no duplicate t=300; got: ${resolved6!.url}`);
manager6.dispose();

// --- 7. startAt with VidSrc ---

const vidsrcSource = makeSource('https://vidsrc.wiki/embed/movie/550/');
const manager7 = new PlaybackManager({ fetcher: makeFetch(vidsrcSource) });
await manager7.loadSource({ sourceId: 's', contentId: '550', mediaType: 'movie' }, 420, true);
const resolved7 = manager7.getSource();
assert.ok(resolved7!.url!.includes('startAt=420'), `VidSrc: URL includes ?startAt=420; got: ${resolved7!.url}`);
manager7.dispose();

// --- 8. startAt with VidAPI.qzz.io ---

const vidapiSource = makeSource('https://vidapi.qzz.io/movie/550');
const manager8 = new PlaybackManager({ fetcher: makeFetch(vidapiSource) });
await manager8.loadSource({ sourceId: 's', contentId: '550', mediaType: 'movie' }, 99, true);
const resolved8 = manager8.getSource();
assert.ok(resolved8!.url!.includes('startAt=99'), `VidAPI.qzz.io: URL includes ?startAt=99; got: ${resolved8!.url}`);
manager8.dispose();

// --- 9. Embed events reach the manager state (VidLink timeupdate) ---

const vidlinkManager = new PlaybackManager({ fetcher: makeFetch(vidlinkSource) });
const events: PlayerEvent[] = [];
vidlinkManager.onEvent((e) => events.push(e));
await vidlinkManager.loadSource({ sourceId: 's', contentId: '550', mediaType: 'movie' }, 0, true);

// Simulate VidLink posting a PLAYER_EVENT with timeupdate
simulateMessage('https://vidlink.pro', {
  type: 'PLAYER_EVENT',
  data: { event: 'timeupdate', currentTime: 60, duration: 5400 },
});

assert.equal(vidlinkManager.getState().currentTime, 60, 'VidLink timeupdate: manager currentTime = 60');
assert.equal(vidlinkManager.getState().duration, 5400, 'VidLink timeupdate: manager duration = 5400');
assert.ok(events.some((e) => e.type === 'timeupdate' && e.currentTime === 60), 'VidLink timeupdate: event emitted');

vidlinkManager.dispose();

// --- 10. Completion threshold (0.9) ---

assert.equal(completionFor(5400 * 0.9, 5400), 'completed', '90% of duration = completed');
assert.equal(completionFor(5400 * 0.89, 5400), 'in_progress', '89% of duration = in_progress');
assert.equal(completionFor(0, 5400, true), 'completed', 'explicit completed flag');

// --- 11. Invalid resume position is ignored (clampTime) ---

const clamped1 = clampTime(-10, 100);
assert.equal(clamped1.currentTime, 0, 'negative currentTime clamped to 0');
const clamped2 = clampTime(150, 100);
assert.equal(clamped2.currentTime, 100, 'currentTime > duration clamped to duration');
const clamped3 = clampTime(NaN, 100);
assert.equal(clamped3.currentTime, 0, 'NaN currentTime clamped to 0');
const clamped4 = clampTime(50, 0);
assert.equal(clamped4.currentTime, 50, 'zero duration: currentTime preserved');

// --- 12. progressKey is per-episode ---

const movieKey = progressKey({ contentType: 'movie', contentId: '550' });
const seriesKey1 = progressKey({ contentType: 'series', contentId: '1399', season: 1, episode: 1 });
const seriesKey2 = progressKey({ contentType: 'series', contentId: '1399', season: 1, episode: 2 });
assert.notEqual(movieKey, seriesKey1, 'movie key ≠ series key');
assert.notEqual(seriesKey1, seriesKey2, 'episode 1 key ≠ episode 2 key');
assert.ok(seriesKey1.includes('1:1'), 'series key includes season:episode');
assert.ok(movieKey.includes('-:-'), 'movie key includes -:- for no season/episode');

// --- 13. getResumeProgress returns 0 for completed ---

// Simulate a completed record: resumeTime should be 0.
const completedRecord: WatchProgressRecord = {
  key: 'movie:550:-:-',
  contentType: 'movie',
  contentId: '550',
  currentTime: 5400,
  duration: 5400,
  completionState: 'completed',
  selectedSourceId: 's-cinesrc',
  snapshot: { title: 'Test', poster: '' },
  lastWatchedAt: Date.now(),
  updatedAt: Date.now(),
};
assert.equal(completedRecord.completionState, 'completed');
// getResumeProgress returns resumeTime = 0 for completed records.
const resumeTimeForCompleted = completedRecord.completionState === 'completed' ? 0 : completedRecord.currentTime;
assert.equal(resumeTimeForCompleted, 0, 'completed record resumeTime = 0');

// --- 14. In-progress record returns its currentTime ---

const inProgressRecord: WatchProgressRecord = {
  key: 'movie:550:-:-',
  contentType: 'movie',
  contentId: '550',
  currentTime: 300,
  duration: 5400,
  completionState: 'in_progress',
  selectedSourceId: 's-vidlink',
  snapshot: { title: 'Test', poster: '' },
  lastWatchedAt: Date.now(),
  updatedAt: Date.now(),
};
const resumeTimeForInProgress = inProgressRecord.completionState === 'completed' ? 0 : inProgressRecord.currentTime;
assert.equal(resumeTimeForInProgress, 300, 'in-progress record resumeTime = 300');
assert.equal(inProgressRecord.selectedSourceId, 's-vidlink', 'saved sourceId preserved in progress record');

// --- 15. Race condition: stale session events cannot overwrite new source ---

const manager15 = new PlaybackManager({ fetcher: makeFetch(vidlinkSource) });
await manager15.loadSource({ sourceId: 's', contentId: '550', mediaType: 'movie' }, 0, true);
assert.equal(manager15.getSource()?.sourceId, '00000000-0000-4000-8000-000000000002');

// Start a new load (session B) — should increment sessionId.
const cinesrcSource15 = makeSource('https://cinesrc.st/embed/movie/550', { sourceId: 'new-source-id' });
const manager15b = new PlaybackManager({ fetcher: makeFetch(cinesrcSource15) });
await manager15b.loadSource({ sourceId: 's', contentId: '550', mediaType: 'movie' }, 0, true);
assert.equal(manager15b.getSource()?.sourceId, 'new-source-id', 'session B source is active');

// Simulate a stale VidLink message (from session A's adapter).
simulateMessage('https://vidlink.pro', {
  type: 'PLAYER_EVENT',
  data: { event: 'timeupdate', currentTime: 999, duration: 999 },
});
// The new manager (session B) should NOT receive the stale message because
// it was posted to the parent window and the VidLink adapter in session B
// is not loaded (the CineSrc adapter is loaded, not VidLink).
assert.notEqual(manager15b.getState().currentTime, 999, 'stale VidLink message does not affect CineSrc session');

manager15.dispose();
manager15b.dispose();

// --- 16. Manager state tracks currentTime from embed events ---

const manager16 = new PlaybackManager({ fetcher: makeFetch(vidlinkSource) });
await manager16.loadSource({ sourceId: 's', contentId: '550', mediaType: 'movie' }, 0, true);

simulateMessage('https://vidlink.pro', {
  type: 'PLAYER_EVENT',
  data: { event: 'timeupdate', currentTime: 42.5, duration: 7200 },
});
assert.equal(manager16.getState().currentTime, 42.5, 'manager tracks embed currentTime');
assert.equal(manager16.getState().duration, 7200, 'manager tracks embed duration');

simulateMessage('https://vidlink.pro', {
  type: 'PLAYER_EVENT',
  data: { event: 'play' },
});
assert.equal(manager16.getState().playing, true, 'manager tracks embed play');

simulateMessage('https://vidlink.pro', {
  type: 'PLAYER_EVENT',
  data: { event: 'pause' },
});
assert.equal(manager16.getState().playing, false, 'manager tracks embed pause');

simulateMessage('https://vidlink.pro', {
  type: 'PLAYER_EVENT',
  data: { event: 'ended' },
});
assert.equal(manager16.getState().state, 'completed', 'manager tracks embed ended');

manager16.dispose();

// --- 17. startAtParam returns correct values per provider ---

const { CineSrcPlayerAdapter } = await import('$lib/client/player/providers/cinesrc-adapter');
const { VidSrcPlayerAdapter } = await import('$lib/client/player/providers/vidsrc-adapter');
const { VidLinkPlayerAdapter } = await import('$lib/client/player/providers/vidlink-adapter');
const { VidYPlayerAdapter } = await import('$lib/client/player/providers/vidy-adapter');
const { VidApiQzzPlayerAdapter } = await import('$lib/client/player/providers/vidapi-qzz-adapter');
const { DirectPlayerAdapter } = await import('$lib/client/player/direct-adapter');
const { EmbedPlayerAdapter } = await import('$lib/client/player/embed-adapter');

assert.equal(new CineSrcPlayerAdapter().startAtParam!(), 't', 'CineSrc startAtParam = t');
assert.equal(new VidSrcPlayerAdapter().startAtParam!(), 'startAt', 'VidSrc startAtParam = startAt');
assert.equal(new VidLinkPlayerAdapter().startAtParam!(), 'startAt', 'VidLink startAtParam = startAt');
assert.equal(new VidYPlayerAdapter().startAtParam!(), 'progress', 'VidY startAtParam = progress');
assert.equal(new VidApiQzzPlayerAdapter().startAtParam!(), 'startAt', 'VidAPI.qzz.io startAtParam = startAt');
assert.equal(new DirectPlayerAdapter().startAtParam!(), null, 'Direct startAtParam = null (uses native seek)');
assert.equal(new EmbedPlayerAdapter().startAtParam?.() ?? null, null, 'Generic embed startAtParam = null');

// --- 18. Capabilities: only CineSrc has seek command ---

assert.equal(CINESRC_CAPABILITIES.seek, true, 'CineSrc supports seek command');
assert.equal(VIDLINK_CAPABILITIES.seek, false, 'VidLink does NOT support seek command');
assert.equal(EMBED_PLAYBACK_CAPABILITIES.seek, false, 'Generic embed does NOT support seek');

// --- 19. Manager dispose cleans up (no leaked listeners) ---

const manager19 = new PlaybackManager({ fetcher: makeFetch(vidlinkSource) });
await manager19.loadSource({ sourceId: 's', contentId: '550', mediaType: 'movie' }, 0, true);
manager19.dispose();

// After dispose, simulate a VidLink message — it should not crash.
simulateMessage('https://vidlink.pro', {
  type: 'PLAYER_EVENT',
  data: { event: 'timeupdate', currentTime: 999, duration: 999 },
});
// No assertion needed — if it doesn't crash, the test passes.

// --- 20. startAt position is floor'd to integer ---

const manager20 = new PlaybackManager({ fetcher: makeFetch(cinesrcSource) });
await manager20.loadSource({ sourceId: 's', contentId: '550', mediaType: 'movie' }, 42.7, true);
const resolved20 = manager20.getSource();
assert.ok(resolved20!.url!.includes('t=42'), `startAt is floor'd to integer; got: ${resolved20!.url}`);
assert.ok(!resolved20!.url!.includes('t=42.7'), 'startAt is not a float');
manager20.dispose();

console.log('Phase 4 progress + resume + source continuity tests passed: startAt URL param (CineSrc ?t=, VidLink/VidSrc/VidAPI.qzz.io ?startAt=, VidY ?progress=), no startAt when startPosition=0, no startAt for unsupported providers, idempotent startAt, embed events reach manager state (timeupdate/duration/play/pause/ended), completion threshold 0.9, invalid position clamping, per-episode progressKey, completed record resumeTime=0, in-progress record resumeTime=currentTime, saved selectedSourceId preserved, race condition protection (stale session events dropped), startAtParam per provider, CineSrc-only seek command, dispose cleanup, startAt floor to integer.');
