import assert from 'node:assert/strict';
import { playbackSpeeds, type PlayerSource } from '$lib/shared/player';
import { DIRECT_PLAYBACK_CAPABILITIES, EMBED_PLAYBACK_CAPABILITIES } from '$lib/client/player/capabilities';
import { DirectPlayerAdapter } from '$lib/client/player/direct-adapter';
import { EmbedPlayerAdapter } from '$lib/client/player/embed-adapter';
import { PlayerAdapterRegistry, createDefaultAdapterRegistry } from '$lib/client/player/adapter-registry';
import type { PlayerEvent } from '$lib/client/player/events';
import { PlaybackManager, ResolverError, type ResolverRequest } from '$lib/client/player/PlaybackManager';

// Phase 1 PlaybackManager contract tests.
//
// These tests verify the orchestration architecture (not browser-specific
// playback behavior — that requires manual testing). Focus:
//   1. Manager initial state
//   2. Source load lifecycle
//   3. Source switch lifecycle (stale session cannot overwrite active)
//   4. Adapter cleanup on switch/dispose
//   5. Normalized event handling
//   6. Direct/embed distinction (capabilities)
//   7. Resolver error mapping
//   8. Race-condition protection (load A → load B before A resolves → A must not overwrite B)

// --- Test helpers ---

function makeSource(overrides: Partial<PlayerSource> = {}): PlayerSource {
  return {
    type: 'embed',
    url: 'https://example.test/embed/movie/550',
    providerId: '00000000-0000-4000-8000-000000000001',
    sourceId: '00000000-0000-4000-8000-000000000002',
    mediaType: 'movie',
    ...overrides,
  };
}

function makeResolverRequest(source: PlayerSource): ResolverRequest {
  return {
    sourceId: source.sourceId,
    contentId: '550',
    mediaType: 'movie',
  };
}

function makeFetch(payload: { ok?: boolean; source?: PlayerSource | null; error?: { code?: string; message?: string } }, status = 200, delay = 0): typeof fetch {
  return async (_input: RequestInfo | URL, _init?: RequestInit) => {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    }) as unknown as Response;
  };
}

function makeFailingFetch(error: { code?: string; message: string }, status: number): typeof fetch {
  return async () => new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as unknown as Response;
}

// --- 1. Manager initial state ---

const manager = new PlaybackManager();
assert.equal(manager.getSource(), null, 'initial source must be null');
assert.equal(manager.isResolving(), false, 'initial resolving must be false');
assert.equal(manager.getPlaybackState(), 'initial-loading', 'initial playback state must be initial-loading');
assert.equal(manager.getState().currentTime, 0);
assert.equal(manager.getState().duration, 0);
assert.equal(manager.getState().playing, false);
assert.equal(manager.getState().buffering, false);
assert.equal(manager.getState().errorMessage, '');
assert.equal(manager.getState().errorCode, '');
assert.equal(manager.getState().resolutionState, 'idle');

// --- 2. Capabilities defaults ---

assert.equal(DIRECT_PLAYBACK_CAPABILITIES.currentTime, true, 'direct adapter must report currentTime');
assert.equal(DIRECT_PLAYBACK_CAPABILITIES.postMessage, false, 'direct adapter must not report postMessage');
assert.equal(EMBED_PLAYBACK_CAPABILITIES.currentTime, false, 'generic embed must NOT report currentTime (black box)');
assert.equal(EMBED_PLAYBACK_CAPABILITIES.fullscreen, true, 'generic embed must report fullscreen (allowfullscreen set)');
assert.equal(EMBED_PLAYBACK_CAPABILITIES.postMessage, false, 'generic embed must NOT report postMessage (Phase 1 has no listener)');

// --- 3. Adapter registry default order (direct before embed) ---
//
// Phase 3 expanded the default registry from 2 adapters (direct + generic
// embed) to 10 (direct + 8 provider-specific + generic embed). The Phase 1
// contract — "DirectPlayerAdapter is first, EmbedPlayerAdapter is last" —
// is preserved. Provider-specific adapters sit between them.

const registry = createDefaultAdapterRegistry();
const adapters = registry.list();
assert.ok(adapters.length >= 2, `registry must contain at least 2 adapters (direct + embed); got ${adapters.length}`);
assert.ok(adapters[0] instanceof DirectPlayerAdapter, 'first adapter must be DirectPlayerAdapter');
assert.ok(adapters[adapters.length - 1] instanceof EmbedPlayerAdapter, 'last adapter must be EmbedPlayerAdapter (generic fallback)');

// Direct adapter only handles direct sources; embed adapter only handles embed.
const directSource = makeSource({ type: 'direct', url: 'https://example.test/movie.mp4' });
const embedSource = makeSource({ type: 'embed', url: 'https://example.test/embed/movie/550' });
assert.ok(registry.pickAdapter(directSource) instanceof DirectPlayerAdapter);
assert.ok(registry.pickAdapter(embedSource) instanceof EmbedPlayerAdapter);
assert.equal(registry.pickAdapter(makeSource({ type: 'direct', url: '' })), null, 'no adapter handles empty url');

// --- 4. Adapter canHandle is a pure predicate ---

const directAdapter = new DirectPlayerAdapter();
const embedAdapter = new EmbedPlayerAdapter();
assert.equal(directAdapter.canHandle(directSource), true);
assert.equal(directAdapter.canHandle(embedSource), false);
assert.equal(embedAdapter.canHandle(directSource), false);
assert.equal(embedAdapter.canHandle(embedSource), true);

// --- 5. Source load lifecycle (success path) ---

const sourceA = makeSource({ sourceId: 'aaaaaaaa-0000-4000-8000-000000000001' });
const managerA = new PlaybackManager({ fetcher: makeFetch({ ok: true, source: sourceA }) });
const eventsA: PlayerEvent[] = [];
managerA.onEvent((e) => eventsA.push(e));

await managerA.loadSource(makeResolverRequest(sourceA), 0, true);
assert.equal(managerA.getSource()?.sourceId, sourceA.sourceId, 'source A must be loaded');
assert.equal(managerA.isResolving(), false, 'resolving must be false after success');
assert.equal(managerA.getState().resolutionState, 'ready', 'resolution state must be ready');
assert.equal(managerA.getState().state, 'embed-loading', 'embed source initial state must be embed-loading');
assert.equal(managerA.getState().errorMessage, '', 'no error message on success');

// --- 6. Direct source lifecycle has different initial state ---

const directResolvedSource = makeSource({ type: 'direct', url: 'https://example.test/movie.mp4' });
const managerDirect = new PlaybackManager({ fetcher: makeFetch({ ok: true, source: directResolvedSource }) });
await managerDirect.loadSource(makeResolverRequest(directResolvedSource), 60, true);
assert.equal(managerDirect.getSource()?.type, 'direct');
assert.equal(managerDirect.getState().state, 'preparing', 'direct source initial state must be preparing');
assert.equal(managerDirect.getState().pendingSeek, 60, 'pendingSeek must be preserved from startPosition');
assert.equal(managerDirect.getState().capabilities.currentTime, true, 'direct adapter capabilities must be applied');

// --- 7. Resolver error mapping ---

const failingManager = new PlaybackManager({ fetcher: makeFailingFetch({ code: 'UNSUPPORTED_MEDIA_TYPE', message: 'This provider does not support this title type.' }, 422) });
await failingManager.loadSource(makeResolverRequest(sourceA));
assert.equal(failingManager.getSource(), null, 'no source on unsupported media type');
assert.equal(failingManager.getState().resolutionState, 'unsupported');
assert.equal(failingManager.getState().state, 'unsupported');
assert.match(failingManager.getState().errorMessage, /does not support/);

const unavailableManager = new PlaybackManager({ fetcher: makeFailingFetch({ code: 'SOURCE_DISABLED', message: 'Source disabled.' }, 503) });
await unavailableManager.loadSource(makeResolverRequest(sourceA));
assert.equal(unavailableManager.getState().resolutionState, 'unavailable');
assert.equal(unavailableManager.getState().state, 'unavailable');

const providerErrorManager = new PlaybackManager({ fetcher: makeFailingFetch({ code: 'PROVIDER_RESPONSE_INVALID', message: 'Bad response.' }, 502) });
await providerErrorManager.loadSource(makeResolverRequest(sourceA));
assert.equal(providerErrorManager.getState().resolutionState, 'provider-error');
assert.equal(providerErrorManager.getState().state, 'provider-error');

const networkErrorManager = new PlaybackManager({
  fetcher: async () => { throw new Error('network down'); },
});
await networkErrorManager.loadSource(makeResolverRequest(sourceA));
assert.equal(networkErrorManager.getState().resolutionState, 'network-error');
assert.match(networkErrorManager.getState().errorMessage, /network down/);

// --- 8. Race-condition: load A → load B before A resolves → A must not overwrite B ---

const sourceSlow = makeSource({ sourceId: 'slow-aaaa-0000-4000-8000-000000000001' });
const sourceFast = makeSource({ sourceId: 'fast-bbbb-0000-4000-8000-000000000002' });

let resolveSlow!: () => void;
const slowPromise = new Promise<void>((resolve) => { resolveSlow = resolve; });
const raceManager = new PlaybackManager({
  fetcher: async (_input, init) => {
    const body = init?.body ? JSON.parse(init.body as string) as { sourceId: string } : null;
    if (body?.sourceId === sourceSlow.sourceId) {
      await slowPromise;
      return new Response(JSON.stringify({ ok: true, source: sourceSlow }), { status: 200, headers: { 'content-type': 'application/json' } }) as unknown as Response;
    }
    return new Response(JSON.stringify({ ok: true, source: sourceFast }), { status: 200, headers: { 'content-type': 'application/json' } }) as unknown as Response;
  },
});

// Kick off slow load A; do NOT await.
const slowLoadP = raceManager.loadSource(makeResolverRequest(sourceSlow));
// Immediately kick off fast load B (completes synchronously).
await raceManager.loadSource(makeResolverRequest(sourceFast));
// B should be the active source.
assert.equal(raceManager.getSource()?.sourceId, sourceFast.sourceId, 'fast source B must be active');
// Now resolve slow A.
resolveSlow();
await slowLoadP;
// A must NOT have overwritten B.
assert.equal(raceManager.getSource()?.sourceId, sourceFast.sourceId, 'slow source A must NOT overwrite fast source B');

// --- 9. Adapter cleanup on source switch ---

const sourceB = makeSource({ sourceId: 'bbbbbbbb-0000-4000-8000-000000000002' });
const sourceC = makeSource({ sourceId: 'cccccccc-0000-4000-8000-000000000003' });

let destroyCount = 0;
class CountingAdapter extends EmbedPlayerAdapter {
  override destroy(): void {
    destroyCount += 1;
    super.destroy();
  }
}
const countingRegistry = new PlayerAdapterRegistry([new CountingAdapter()]);
const cleanupManager = new PlaybackManager({
  registry: countingRegistry,
  fetcher: makeFetch({ ok: true, source: sourceB }),
});
await cleanupManager.loadSource(makeResolverRequest(sourceB));
assert.equal(destroyCount, 0, 'no destroy on first load');
const cleanupManager2 = new PlaybackManager({
  registry: countingRegistry,
  fetcher: makeFetch({ ok: true, source: sourceC }),
});
await cleanupManager2.loadSource(makeResolverRequest(sourceB));
await cleanupManager2.loadSource(makeResolverRequest(sourceC));
// The first session's adapter was destroyed when the second loadSource() began.
assert.ok(destroyCount >= 1, `destroy must be called on source switch (got ${destroyCount})`);

// --- 10. Dispose tears down active session ---

let disposedCount = 0;
class DisposedTrackingAdapter extends EmbedPlayerAdapter {
  override destroy(): void {
    disposedCount += 1;
    super.destroy();
  }
}
const disposeManager = new PlaybackManager({
  registry: new PlayerAdapterRegistry([new DisposedTrackingAdapter()]),
  fetcher: makeFetch({ ok: true, source: sourceB }),
});
await disposeManager.loadSource(makeResolverRequest(sourceB));
assert.equal(disposedCount, 0, 'no destroy before dispose');
disposeManager.dispose();
// dispose() calls destroySession() which awaits adapter.destroy().
await new Promise((resolve) => setTimeout(resolve, 10));
assert.ok(disposedCount >= 1, `dispose must call adapter.destroy (got ${disposedCount})`);

// --- 11. After dispose, public methods are no-ops ---

const postDisposeSource = makeSource({ sourceId: 'dddddddd-0000-4000-8000-000000000004' });
const postDisposeManager = new PlaybackManager({
  fetcher: makeFetch({ ok: true, source: postDisposeSource }),
});
postDisposeManager.dispose();
await postDisposeManager.loadSource(makeResolverRequest(postDisposeSource));
assert.equal(postDisposeManager.getSource(), null, 'loadSource after dispose must be a no-op');

// --- 12. Viewport event dispatch translates to normalized events ---

const viewSource = makeSource({ type: 'direct', url: 'https://example.test/movie.mp4' });
const viewManager = new PlaybackManager({ fetcher: makeFetch({ ok: true, source: viewSource }) });
const viewEvents: PlayerEvent[] = [];
viewManager.onEvent((e) => viewEvents.push(e));
await viewManager.loadSource(makeResolverRequest(viewSource));
viewManager.dispatchViewportEvent({ type: 'loadedmetadata', currentTime: 0, duration: 7200 });
assert.equal(viewManager.getState().duration, 7200, 'duration must be set from loadedmetadata');
viewManager.dispatchViewportEvent({ type: 'play' });
assert.equal(viewManager.getState().playing, true, 'play event must set playing=true');
assert.equal(viewManager.getState().state, 'playing');
viewManager.dispatchViewportEvent({ type: 'timeupdate', currentTime: 5, duration: 7200 });
assert.equal(viewManager.getState().currentTime, 5, 'timeupdate must set currentTime');
viewManager.dispatchViewportEvent({ type: 'pause' });
assert.equal(viewManager.getState().playing, false);
assert.equal(viewManager.getState().state, 'paused');
viewManager.dispatchViewportEvent({ type: 'ended' });
assert.equal(viewManager.getState().state, 'completed');
viewManager.dispatchViewportEvent({ type: 'error' });
assert.equal(viewManager.getState().state, 'error');
assert.match(viewManager.getState().errorMessage, /could not be started/);
assert.ok(viewEvents.length >= 5, `subscribers must receive events (got ${viewEvents.length})`);

// --- 13. State subscription is invoked on every patch ---

const subSource = makeSource({ sourceId: 'sub-aaaa-0000-4000-8000-000000000010' });
const subManager = new PlaybackManager({ fetcher: makeFetch({ ok: true, source: subSource }) });
const snapshots: PlaybackManagerSnapshot[] = [];
type PlaybackManagerSnapshot = ReturnType<typeof subManager.getState>;
const unsubscribe = subManager.subscribe((snapshot) => snapshots.push(snapshot));
assert.ok(snapshots.length >= 1, 'subscribe must emit current snapshot immediately');
const initialSnapshotCount = snapshots.length;
await subManager.loadSource(makeResolverRequest(subSource));
assert.ok(snapshots.length > initialSnapshotCount, 'subscribe must be called on state change after loadSource');
// Mutate state via dispatch and confirm subscriber fires.
viewManager.dispatchViewportEvent.call(subManager, { type: 'play' } as never);
// Note: the above line uses viewManager.dispatchViewportEvent but we want subManager.
// Re-do properly:
subManager.dispatchViewportEvent({ type: 'loadedmetadata', currentTime: 0, duration: 3600 });
const beforePlay = snapshots.length;
subManager.dispatchViewportEvent({ type: 'play' });
assert.ok(snapshots.length > beforePlay, 'subscribe must fire on play event');
unsubscribe();
const afterUnsubscribe = snapshots.length;
subManager.dispatchViewportEvent({ type: 'pause' });
assert.equal(snapshots.length, afterUnsubscribe, 'unsubscribe must stop notifications');

// --- 14. Stale session events are dropped (post-dispose dispatch is a no-op) ---

const staleSource = makeSource({ sourceId: 'eeeeeeee-0000-4000-8000-000000000005' });
const staleManager = new PlaybackManager({ fetcher: makeFetch({ ok: true, source: staleSource }) });
await staleManager.loadSource(makeResolverRequest(staleSource));
const beforeDispose = staleManager.getState().state;
staleManager.dispose();
staleManager.dispatchViewportEvent({ type: 'timeupdate', currentTime: 999, duration: 999 });
// After dispose, the manager's state is frozen — the late event must not mutate it.
// We can read getState() but it returns the last snapshot before dispose.
assert.equal(staleManager.getState().state, beforeDispose, 'late event after dispose must not mutate state');

// --- 15. ResolverError class ---

const re = new ResolverError('TEST_CODE', 'test message');
assert.equal(re.code, 'TEST_CODE');
assert.equal(re.message, 'test message');
assert.equal(re.name, 'ResolverError');

// --- 16. playbackSpeeds export unchanged (regression check) ---

assert.deepEqual([...playbackSpeeds], [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);

console.log('Phase 1 PlaybackManager contract tests passed: initial state, capabilities defaults, adapter registry order, source load lifecycle (embed + direct), resolver error mapping (unsupported/unavailable/provider-error/network-error), race-condition protection (slow A does not overwrite fast B), adapter cleanup on source switch, dispose teardown, normalized viewport event translation, stale event drop, state subscribe/unsubscribe, ResolverError shape.');
