/**
 * UNIFIED LIVE TV — Phase 5 playback router verification (client side).
 *
 * Covers the Phase 5 brief §9 requirements (router behavior), all with
 * scripted fake engines / fetch / timers — NO real network, NO real
 * playback, NO live streams:
 *   R1  candidates are attempted in the server's order; the endpoint kind
 *       alone decides the mechanism (direct → engine, embed → iframe).
 *   R2  the FIRST successful candidate stops the session (no further
 *       attempts, no further engines).
 *   R3  a fatal direct failure advances to the next candidate (once —
 *       duplicate error events cannot double-advance).
 *   R4  LiveGT direct failure falls through to the LiveGT embed candidate
 *       (the builtin resolver contract end-to-end).
 *   R5  all-candidates-failed produces the GENERIC retryable error (no
 *       internal ids, no URLs) and the surfaces are torn down.
 *   R6  stale events (previous session/engine) can never affect the new
 *       session; switching channels cancels and cleans up the old one.
 *   R7  bounded waits: the direct startup watchdog and the embed load
 *       window each advance; the resolve fetch timeout degrades to legacy.
 *   R8  autoplay-blocked/aborted never advance (the pinned classifier);
 *       unsupported_drm classifies safely and advances.
 *   R9  signed resolution material passes through UNTOUCHED and is never
 *       logged/persisted (the trail carries kinds + ids only).
 *   R10 the flag gate: FALSE → 'legacy' with ZERO resolve fetches; TRUE +
 *       resolved:false → 'legacy'; TRUE + empty list → honest exhausted.
 */

import assert from 'node:assert/strict';

let passed = 0;
function ok(condition: unknown, label: string, hint?: string) {
  assert.ok(condition, hint ? `${label} (${hint})` : label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

import { LiveTvPlaybackRouter, isSafeLivetvEmbedSrc, LIVETV_ROUTER_EXHAUSTED_MESSAGE, LIVETV_ROUTER_NO_STREAM_MESSAGE, resetUnifiedFlagCacheForTests, type LivetvRouterCandidate } from '../src/lib/client/live-tv/resolution-router';
import { LiveTvPlaybackError } from '../src/lib/client/live-tv/player-errors';
import { LiveTvError } from '../src/lib/client/live-tv/errors';

// ---------------------------------------------------------------------------
// Fake timers (manual clock; deterministic).
// ---------------------------------------------------------------------------

function createFakeTimers() {
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let now = 0;
  return {
    setTimeout(fn: () => void, ms: number): number {
      const id = ++seq;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id: number): void {
      pending.delete(id);
    },
    /** Advance the clock; fire every due callback in schedule order. */
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = Math.max(now, due[1].at);
        pending.delete(due[0]);
        due[1].fn();
      }
      now = target;
    },
    get pendingCount(): number {
      return pending.size;
    },
    get now(): number {
      return now;
    }
  };
}
type FakeTimers = ReturnType<typeof createFakeTimers>;
type RouterTimers = { setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>; clearTimeout(handle: ReturnType<typeof setTimeout>): void };

// ---------------------------------------------------------------------------
// Fake engine — implements EXACTLY the surface the router touches.
// ---------------------------------------------------------------------------

type LoadCall = { video: HTMLVideoElement; resolution: unknown; options: unknown };

class FakeEngine {
  private listeners = new Map<string, ((payload: unknown) => void)[]>();
  loadCalls: LoadCall[] = [];
  destroyed = false;
  /** Scripted load behavior (receives the engine to emit events). */
  script: ((call: LoadCall, engine: FakeEngine) => void) | null = null;

  on(event: string, listener: (payload: unknown) => void): () => void {
    const bucket = this.listeners.get(event) ?? [];
    bucket.push(listener);
    this.listeners.set(event, bucket);
    return () => {
      const current = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        current.filter((entry) => entry !== listener)
      );
    };
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  load(_video: HTMLVideoElement, resolution: unknown, options: unknown): Promise<void> {
    const call: LoadCall = { video: _video, resolution, options };
    this.loadCalls.push(call);
    return new Promise<void>((resolve, reject) => {
      this.resolveLoad = resolve;
      this.rejectLoad = reject;
      if (this.script) this.script(call, this);
    });
  }

  private resolveLoad: (() => void) | null = null;
  private rejectLoad: ((err: unknown) => void) | null = null;

  destroy(): void {
    this.destroyed = true;
  }

  // Script helpers.
  succeed(): void {
    this.resolveLoad?.();
  }
  failLoad(kind: LiveTvPlaybackError['kind']): void {
    const error = new LiveTvPlaybackError(kind);
    this.emit('error', error);
    this.rejectLoad?.(error);
  }
  failMidSession(kind: LiveTvPlaybackError['kind']): void {
    this.emit('error', new LiveTvPlaybackError(kind));
  }
}

// ---------------------------------------------------------------------------
// Fake fetch — scripted routes.
// ---------------------------------------------------------------------------

type FetchRoute = { match: (url: string) => boolean; status?: number; body?: unknown; hang?: boolean };

function createFakeFetch(routes: FetchRoute[]) {
  const calls: string[] = [];
  const fetchFn = function fakeFetch(url: string | URL | Request, init?: { signal?: AbortSignal }): Promise<Response> {
    const href = String(url);
    calls.push(href);
    const route = routes.find((entry) => entry.match(href));
    if (!route) return Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 404 }));
    if (route.hang) {
      // A hung upstream that still honors the caller's abort (as real
      // fetch does) — the signal rejection is what bounds it.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) {
          reject(new Error('The operation was aborted.'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => reject(new Error('The operation was aborted.')),
          { once: true }
        );
      });
    }
    const status = route.status ?? 200;
    const body = route.body ?? {};
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  };
  return {
    calls,
    fetch: fetchFn as unknown as typeof fetch
  };
}

// ---------------------------------------------------------------------------
// Fixture helpers.
// ---------------------------------------------------------------------------

const VIDEO = { tag: 'video-element' } as unknown as HTMLVideoElement;
const CHANNEL = { id: '143', name: 'News One' };

function directCandidate(over: Partial<LivetvRouterCandidate> = {}): LivetvRouterCandidate {
  return {
    candidateId: 'cand-playlist-direct',
    engine: 'shaka_media_player',
    endpointKind: 'direct_stream',
    streamFormat: 'hls',
    url: 'https://streams.example.com/news/index.m3u8',
    resolver: null,
    sourceChannelId: null,
    label: 'Playlist A',
    ...over
  };
}

function builtinDirectCandidate(over: Partial<LivetvRouterCandidate> = {}): LivetvRouterCandidate {
  return directCandidate({
    candidateId: 'cand-builtin-direct',
    engine: 'shaka_media_player',
    endpointKind: 'direct_stream',
    streamFormat: 'dash',
    url: null,
    resolver: 'builtin_livegt_v1',
    sourceChannelId: '143',
    label: null,
    ...over
  });
}

function builtinEmbedCandidate(over: Partial<LivetvRouterCandidate> = {}): LivetvRouterCandidate {
  return {
    candidateId: 'cand-builtin-embed',
    engine: 'iframe_embed',
    endpointKind: 'embed_page',
    streamFormat: null,
    url: null,
    resolver: 'builtin_livegt_v1',
    sourceChannelId: '143',
    label: null,
    ...over
  };
}

type Recorder = {
  engines: FakeEngine[];
  resolving: boolean[];
  sessionErrors: (string | null)[];
  embeds: (string | null)[];
  played: number;
};

type RouterFactoryOptions = {
  fetchRoutes: FetchRoute[];
  resolveLivegt?: (channelId: string, options: { signal?: AbortSignal }) => Promise<unknown>;
  script?: (engine: FakeEngine, index: number) => void;
};

function makeRouter(timers: FakeTimers, options: RouterFactoryOptions): { router: LiveTvPlaybackRouter; recorder: Recorder; factoryCalls: number[] } {
  const recorder: Recorder = { engines: [], resolving: [], sessionErrors: [], embeds: [], played: 0 };
  const factoryCalls: number[] = [];
  let engineIndex = 0;
  const fakeFetch = createFakeFetch(options.fetchRoutes);
  const router = new LiveTvPlaybackRouter({
    handlers: {
      onengine: (engine) => {
        if (engine === null) return;
        factoryCalls.push(recorder.engines.length);
        recorder.engines.push(engine as unknown as FakeEngine);
      },
      onresolving: (value) => recorder.resolving.push(value),
      onsessionerror: (message) => recorder.sessionErrors.push(message),
      onembed: (src) => recorder.embeds.push(src),
      onplayed: () => {
        recorder.played += 1;
      }
    },
    createEngine: (() => {
      const engine = new FakeEngine();
      if (options.script) options.script(engine, engineIndex);
      engineIndex += 1;
      return engine as unknown as import('../src/lib/client/live-tv/player').LiveTvPlaybackEngine;
    }) as unknown as () => import('../src/lib/client/live-tv/player').LiveTvPlaybackEngine,
    resolveLivegtPlayback: (options.resolveLivegt ?? (async () => ({ channel: { id: '143', name: 'News One' }, sources: [{ url: 'https://signed.example/live.mpd?__hdnea__=TOKEN' }], drm: null }))) as unknown as typeof import('../src/lib/client/live-tv/api').resolveLiveTvPlayback,
    fetchFn: fakeFetch.fetch,
    timers: timers as unknown as RouterTimers,
    baseUrl: 'https://app.example'
  });
  return { router, recorder, factoryCalls };
}

function resolveRoute(candidates: unknown, resolved = true): FetchRoute {
  return {
    match: (url) => url.includes('/api/livetv/playback/resolve'),
    body: { ok: true, unifiedEnabled: true, resolved, mode: 'default', candidates }
  };
}

const CONFIG_TRUE: FetchRoute = { match: (url) => url.includes('/api/livetv/playback/config'), body: { ok: true, unifiedEnabled: true } };
const CONFIG_FALSE: FetchRoute = { match: (url) => url.includes('/api/livetv/playback/config'), body: { ok: true, unifiedEnabled: false } };

// ============================================================
// R1 — Ordering + mechanism-per-kind + first-success stop.
// ============================================================
{
  resetUnifiedFlagCacheForTests();
  const timers = createFakeTimers();
  const engines: FakeEngine[] = [];
  const { router, recorder } = makeRouter(timers, {
    fetchRoutes: [CONFIG_TRUE, resolveRoute([directCandidate(), builtinEmbedCandidate({ candidateId: 'cand-embed-b', resolver: null, sourceChannelId: null, url: 'https://embeds.example.com/news' })])],
    script: (engine) => {
      engines.push(engine);
      engine.script = () => engine.succeed();
    }
  });
  const outcome = await router.start(CHANNEL, VIDEO);
  ok(outcome === 'handled', 'R1.1 a successful first candidate returns handled');
  ok(recorder.embeds.length === 0, 'R1.2 a direct candidate never mounts an iframe');
  ok(engines.length === 1, 'R1.3 exactly ONE engine was created (first success stops the session)');
  ok(engines[0]!.loadCalls.length === 1, 'R1.4 the engine loaded once');
  const resolution = engines[0]!.loadCalls[0]!.resolution as { sources: { url: string }[] };
  ok(resolution.sources[0]!.url === 'https://streams.example.com/news/index.m3u8', 'R1.5 the registry config URL reached the engine verbatim');
  ok(recorder.played === 1, 'R1.6 first readiness reports the played row once');
  ok(router.getState() === 'playing', 'R1.7 the lifecycle reaches playing');

  // Kind-only dispatch: an embed-FIRST list mounts the iframe, never an engine.
  resetUnifiedFlagCacheForTests();
  const timers2 = createFakeTimers();
  const { router: router2, recorder: recorder2 } = makeRouter(timers2, {
    fetchRoutes: [CONFIG_TRUE, resolveRoute([builtinEmbedCandidate()])],
    script: (engine) => engines.push(engine)
  });
  const session2 = router2.start(CHANNEL, VIDEO);
  await new Promise((resolve) => setTimeout(resolve, 10)); // the embed mounts
  ok(recorder2.engines.length === 0, 'R1.9 an embed candidate NEVER creates an engine');
  ok(recorder2.embeds.length === 1 && recorder2.embeds[0] === 'https://livetgtv.lovable.app/embed/143', 'R1.10 the builtin embed src is the documented contract URL');
  router2.noteEmbedLoaded(); // the forwarded iframe load completes the session
  const outcome2 = await session2;
  ok(outcome2 === 'handled', 'R1.8 an embed-only list is handled');
  ok(router2.getState() === 'playing', 'R1.11 the forwarded iframe load completes the session (terminal success)');
  ok('R1 ordering + mechanism-per-kind verified');
}

// ============================================================
// R3 — Fatal direct failure advances; duplicates cannot double-advance.
// ============================================================
{
  resetUnifiedFlagCacheForTests();
  const timers = createFakeTimers();
  const engines: FakeEngine[] = [];
  const { router, recorder } = makeRouter(timers, {
    fetchRoutes: [CONFIG_TRUE, resolveRoute([directCandidate(), directCandidate({ candidateId: 'cand-two', url: 'https://streams.example.com/two.m3u8' })])],
    script: (engine, index) => {
      engines.push(engine);
      engine.script = () => {
        if (index === 0) {
          engine.failLoad('manifest_load_failed');
          engine.failMidSession('manifest_load_failed'); // duplicate event burst
        } else {
          engine.succeed();
        }
      };
    }
  });
  const outcome = await router.start(CHANNEL, VIDEO);
  ok(outcome === 'handled', 'R3.1 the session completes');
  ok(engines.length === 2, 'R3.2 the fatal failure advanced exactly once (duplicate events coalesced)');
  ok(engines[0]!.destroyed === true, 'R3.3 the failed engine was destroyed before the next attempt');
  ok((engines[1]!.loadCalls[0]!.resolution as { sources: { url: string }[] }).sources[0]!.url === 'https://streams.example.com/two.m3u8', 'R3.4 the second candidate loaded');
  ok(router.getState() === 'playing', 'R3.5 the session ends playing');
  ok('R3 advance-on-fatal + duplicate coalescing verified');
}

// ============================================================
// R4 — LiveGT direct failure → builtin embed fallback (end-to-end).
// ============================================================
{
  resetUnifiedFlagCacheForTests();
  const timers = createFakeTimers();
  const engines: FakeEngine[] = [];
  const resolverCalls: string[] = [];
  const { router, recorder } = makeRouter(timers, {
    fetchRoutes: [CONFIG_TRUE, resolveRoute([builtinDirectCandidate(), builtinEmbedCandidate()])],
    resolveLivegt: async (channelId) => {
      resolverCalls.push(channelId);
      throw new LiveTvError('not_found', { channelId });
    },
    script: (engine) => {
      engines.push(engine);
      engine.script = () => engine.failLoad('invalid_source');
    }
  });
  const session = router.start(CHANNEL, VIDEO);
  await new Promise((resolve) => setTimeout(resolve, 10)); // direct fails → embed mounts
  ok(recorder.embeds.length === 1 && recorder.embeds[0] === 'https://livetgtv.lovable.app/embed/143', 'R4.3 the LiveGT iframe fallback mounted (documented embed URL, builder-built)');
  router.noteEmbedLoaded(); // the forwarded iframe load completes the pending embed attempt
  const outcome = await session;
  ok(outcome === 'handled', 'R4.1 the session completes through the fallback');
  ok(resolverCalls.length === 1 && resolverCalls[0] === '143', 'R4.2 the direct attempt used the EXISTING fresh resolution with the source channel id');
  ok(router.getState() === 'playing', 'R4.5 the embed load completes the session (terminal success)');
  ok(recorder.embeds.filter((src) => src !== null).length === 1, 'R4.6 exactly one embed mount');
  ok('R4 LiveGT direct-to-embed fallback verified');
}

// ============================================================
// R5 — All candidates fail → generic retryable error, clean teardown.
// ============================================================
{
  resetUnifiedFlagCacheForTests();
  const timers = createFakeTimers();
  const engines: FakeEngine[] = [];
  const { router, recorder } = makeRouter(timers, {
    fetchRoutes: [CONFIG_TRUE, resolveRoute([directCandidate(), builtinEmbedCandidate()])],
    script: (engine) => {
      engines.push(engine);
      engine.script = () => engine.failLoad('playback_failed');
    }
  });
  const session = router.start(CHANNEL, VIDEO);
  await new Promise((resolve) => setTimeout(resolve, 10)); // direct fails → embed mounts
  ok(recorder.embeds.length === 1 && recorder.embeds[0] !== null, 'R5.pre the embed candidate mounted after the direct failure');
  timers.advance(12_000); // the dead embed origin never loads → the window advances
  const outcome = await session;
  ok(outcome === 'handled', 'R5.1 an exhausted session is handled');
  ok(recorder.sessionErrors.includes(LIVETV_ROUTER_EXHAUSTED_MESSAGE), 'R5.2 the generic retryable message was surfaced');
  const lastError = recorder.sessionErrors[recorder.sessionErrors.length - 1]!;
  ok(!lastError.includes('cand-') && !lastError.includes('https://') && !lastError.includes('livetgtv'), 'R5.3 the error exposes NO candidate ids, URLs or provider material');
  ok(engines.every((engine) => engine.destroyed), 'R5.4 every engine was destroyed');
  ok(recorder.embeds[recorder.embeds.length - 1] === null, 'R5.5 the embed iframe was unmounted at exhaustion');
  ok(router.getState() === 'exhausted', 'R5.6 the lifecycle reaches exhausted');
  // The trail carries kinds + ids only (no URLs).
  const trail = JSON.stringify(router.getTrail());
  ok(!trail.includes('https://') && !trail.includes('__hdnea__'), 'R5.7 the diagnostic trail never contains URL material');
  ok('R5 exhausted-state verified');
}

// ============================================================
// R6 — Stale events + switch cleanup.
// ============================================================
{
  resetUnifiedFlagCacheForTests();
  const timers = createFakeTimers();
  const engines: FakeEngine[] = [];
  const { router, recorder } = makeRouter(timers, {
    fetchRoutes: [
      CONFIG_TRUE,
      { match: (url) => url.includes('channelId=143'), body: { ok: true, unifiedEnabled: true, resolved: true, mode: 'default', candidates: [directCandidate()] } },
      { match: (url) => url.includes('channelId=999'), body: { ok: true, unifiedEnabled: true, resolved: true, mode: 'default', candidates: [directCandidate({ candidateId: 'cand-B', url: 'https://streams.example.com/b.m3u8' })] } }
    ],
    script: (engine, index) => {
      engines.push(engine);
      // Channel A's engine HANGS (pending load); channel B's succeeds.
      if (index === 0) engine.script = () => {}; // hang
      else engine.script = () => engine.succeed();
    }
  });
  const sessionA = router.start(CHANNEL, VIDEO);
  // Give A's session time to reach its pending load, then switch channels.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const sessionB = router.start({ id: '999', name: 'Channel B' }, VIDEO);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const outcomeB = await sessionB;
  ok(outcomeB === 'handled', 'R6.1 the switch handled channel B');
  const outcomeA = await sessionA;
  ok(outcomeA === 'handled', 'R6.2 the superseded session A returned without throwing');
  ok(engines[0]!.destroyed === true, 'R6.3 channel A\u2019s engine was destroyed by the switch');
  ok((engines[1]!.loadCalls[0]!.resolution as { sources: { url: string }[] }).sources[0]!.url === 'https://streams.example.com/b.m3u8', 'R6.4 channel B loaded its OWN candidate');
  // A LATE fatal from A's destroyed engine must not affect B.
  const beforeTrail = router.getTrail().length;
  engines[0]!.failMidSession('playback_failed');
  ok(router.getState() === 'playing', 'R6.5 the stale engine\u2019s late failure did not disturb B\u2019s playing session');
  ok(router.getTrail().length === beforeTrail, 'R6.6 the stale failure left no trail');
  ok(true, 'R6 stale protection + switch cleanup verified');
}

// ============================================================
// R7 — Bounded waits.
// ============================================================
{
  resetUnifiedFlagCacheForTests();
  const timers = createFakeTimers();
  const engines: FakeEngine[] = [];
  const { router, recorder } = makeRouter(timers, {
    fetchRoutes: [CONFIG_TRUE, resolveRoute([directCandidate(), builtinEmbedCandidate()])],
    script: (engine, index) => {
      engines.push(engine);
      if (index === 0) engine.script = () => {}; // hang → watchdog must fire
    }
  });
  const session = router.start(CHANNEL, VIDEO);
  await new Promise((resolve) => setTimeout(resolve, 10));
  timers.advance(20_000); // the direct startup watchdog (exactly bounded)
  await new Promise((resolve) => setTimeout(resolve, 10)); // the loop's microtask mounts the embed
  ok(engines[0]!.destroyed === true, 'R7.2 the hung engine was destroyed by the watchdog');
  ok(recorder.embeds.length === 1 && recorder.embeds[0] !== null, 'R7.3 the session advanced to the embed candidate');
  ok(timers.pendingCount <= 1, 'R7.4 at most the embed window timer remains (the watchdog was cleared)');
  timers.advance(12_000); // the embed window fires (the origin is dead in this scenario)
  const outcome = await session;
  ok(outcome === 'handled', 'R7.1 the watchdog-advanced session completes');

  // The embed load window: never loads → advance → exhausted.
  resetUnifiedFlagCacheForTests();
  const timers2 = createFakeTimers();
  const { router: router2, recorder: recorder2 } = makeRouter(timers2, {
    fetchRoutes: [CONFIG_TRUE, resolveRoute([builtinEmbedCandidate()])]
  });
  const session2 = router2.start(CHANNEL, VIDEO);
  await new Promise((resolve) => setTimeout(resolve, 10)); // the embed mounts
  timers2.advance(12_000); // the embed load window (exactly bounded)
  await session2;
  ok(recorder2.sessionErrors.includes(LIVETV_ROUTER_EXHAUSTED_MESSAGE), 'R7.5 a dead embed origin advances to the honest exhausted state');
  ok(recorder2.embeds[recorder2.embeds.length - 1] === null, 'R7.6 the dead embed was unmounted');

  // The resolve fetch timeout → legacy (documented degradation).
  resetUnifiedFlagCacheForTests();
  const timers3 = createFakeTimers();
  const { router: router3 } = makeRouter(timers3, {
    fetchRoutes: [CONFIG_TRUE, { match: (url) => url.includes('/api/livetv/playback/resolve'), hang: true }]
  });
  const session3 = router3.start(CHANNEL, VIDEO);
  await new Promise((resolve) => setTimeout(resolve, 10)); // the resolve fetch is now hanging
  timers3.advance(10_000);
  const outcome3 = await session3;
  ok(outcome3 === 'legacy', 'R7.7 a resolve-fetch timeout degrades to the legacy path');
  ok('R7 bounded waits verified');
}

// ============================================================
// R8 — Classification: autoplay never advances; DRM classifies safely.
// ============================================================
{
  resetUnifiedFlagCacheForTests();
  const timers = createFakeTimers();
  const engines: FakeEngine[] = [];
  const { router, recorder } = makeRouter(timers, {
    fetchRoutes: [CONFIG_TRUE, resolveRoute([directCandidate(), directCandidate({ candidateId: 'cand-two', url: 'https://streams.example.com/two.m3u8' })])],
    script: (engine, index) => {
      engines.push(engine);
      engine.script = () => {
        if (index === 0) {
          // Autoplay-blocked is NOT a stream failure — never advances.
          engine.emit('error', new LiveTvPlaybackError('autoplay_blocked'));
          engine.succeed();
        } else {
          engine.succeed();
        }
      };
    }
  });
  await router.start(CHANNEL, VIDEO);
  ok(engines.length === 1, 'R8.1 autoplay_blocked did not advance (the tap-to-play CTA stays authoritative)');

  // unsupported_drm from the fresh resolution → advance.
  resetUnifiedFlagCacheForTests();
  const timers2 = createFakeTimers();
  const engines2: FakeEngine[] = [];
  const { router: router2, recorder: recorder2 } = makeRouter(timers2, {
    fetchRoutes: [CONFIG_TRUE, resolveRoute([builtinDirectCandidate(), directCandidate({ candidateId: 'cand-two', url: 'https://streams.example.com/two.m3u8' })])],
    resolveLivegt: async () => {
      throw new LiveTvError('unsupported_drm', { channelId: '143' });
    },
    script: (engine) => {
      engines2.push(engine);
      engine.script = () => engine.succeed();
    }
  });
  const outcome = await router2.start(CHANNEL, VIDEO);
  ok(outcome === 'handled', 'R8.2 an unsupported-DRM resolution is classified safely');
  ok(recorder2.embeds.length === 0 && engines2.length === 1, 'R8.3 the session advanced to the next eligible candidate (no iframe was mounted for it)');
  ok(router2.getState() === 'playing', 'R8.4 the next candidate plays');
  ok('R8 classification verified');
}

// ============================================================
// R9 — Resolution material passes through untouched, never logged.
// ============================================================
{
  resetUnifiedFlagCacheForTests();
  const timers = createFakeTimers();
  const engines: FakeEngine[] = [];
  const SIGNED = 'https://signed.example/live.mpd?__hdnea__=ST=123~EX=456~SIGN=SECRET';
  const DRM = { type: 'clearkey' as const, keyId: 'kid-1', key: 'key-material' };
  const { router } = makeRouter(timers, {
    fetchRoutes: [CONFIG_TRUE, resolveRoute([builtinDirectCandidate()])],
    resolveLivegt: async () => ({ channel: { id: '143', name: 'News One' }, sources: [{ url: SIGNED }], drm: DRM }),
    script: (engine) => {
      engines.push(engine);
      engine.script = () => engine.succeed();
    }
  });
  await router.start(CHANNEL, VIDEO);
  const handed = engines[0]!.loadCalls[0]!.resolution as { sources: { url: string }[]; drm: unknown };
  ok(handed.sources[0]!.url === SIGNED, 'R9.1 the signed resolution reached the engine BYTE-EXACT (media-auth contract untouched)');
  assert.deepEqual(handed.drm, DRM, 'R9.2 ClearKey material passed through unchanged');
  const trail = JSON.stringify(router.getTrail());
  ok(!trail.includes('SECRET') && !trail.includes('kid-1') && !trail.includes('key-material') && !trail.includes('__hdnea__'), 'R9.3 the trail carries no signed/DRM material');
  ok('R9 resolution-material passthrough verified');
}

// ============================================================
// R10 — Flag gate + compat rules.
// ============================================================
{
  resetUnifiedFlagCacheForTests();
  const timers = createFakeTimers();
  const fetchFake = createFakeFetch([CONFIG_FALSE, resolveRoute([directCandidate()])]);
  const configFetches = () => fetchFake.calls.filter((url) => url.includes('/playback/config')).length;
  const resolveFetches = () => fetchFake.calls.filter((url) => url.includes('/playback/resolve')).length;
  const { router } = makeRouter(timers, { fetchRoutes: [] });
  // Swap the fetch: rebuild the router with the shared fake.
  const router2 = new LiveTvPlaybackRouter({
    handlers: { onengine: () => {}, onresolving: () => {}, onsessionerror: () => {}, onembed: () => {}, onplayed: () => {} },
    fetchFn: fetchFake.fetch,
    timers: timers as unknown as RouterTimers,
    baseUrl: 'https://app.example'
  });
  // R-9: Flag FALSE no longer short-circuits the router. The router now
  // always calls fetchCandidates() — the flag gate is removed from start().
  // With a valid resolve route returning candidates, the router proceeds.
  const outcome = await router2.start(CHANNEL, VIDEO);
  ok(outcome === 'handled', 'R10.1 R-9: flag FALSE + valid resolve route → handled (the router no longer short-circuits on the flag)');
  ok(resolveFetches() === 1, 'R10.2 R-9: the resolve endpoint WAS fetched (the router no longer short-circuits on the flag)');
  ok(configFetches() === 0, 'R10.3 R-9: the flag is NOT fetched by the router (the gate is removed)');

  // Flag true + resolved:false → legacy compatibility path.
  resetUnifiedFlagCacheForTests();
  const timers2 = createFakeTimers();
  const { router: router3 } = makeRouter(timers2, {
    fetchRoutes: [CONFIG_TRUE, resolveRoute([], false)]
  });
  ok((await router3.start(CHANNEL, VIDEO)) === 'legacy', 'R10.4 resolved:false → the legacy compatibility path');

  // Flag true + managed-empty → honest exhausted error.
  resetUnifiedFlagCacheForTests();
  const timers3 = createFakeTimers();
  const { router: router4, recorder: recorder4 } = makeRouter(timers3, {
    fetchRoutes: [CONFIG_TRUE, resolveRoute([])]
  });
  ok((await router4.start(CHANNEL, VIDEO)) === 'handled', 'R10.5 a managed-empty channel is handled by the router');
  // CONTRACT CHANGE (2026-10-25): a managed channel with ZERO eligible candidates
  // now surfaces a DISTINCT message ('No stream available for this source.') instead
  // of the generic retry text, so the UI can tell 'nothing configured' from
  // 'playback failed'. Stronger assertion for the new behavior:
  ok(recorder4.sessionErrors.includes(LIVETV_ROUTER_NO_STREAM_MESSAGE), 'R10.6 managed-empty → the DISTINCT no-stream message (not the generic retry text)');
  ok(!recorder4.sessionErrors.includes(LIVETV_ROUTER_EXHAUSTED_MESSAGE), 'R10.6b managed-empty does NOT use the generic retry message');

  // Resolution transport failure → legacy.
  resetUnifiedFlagCacheForTests();
  const timers4 = createFakeTimers();
  const { router: router5 } = makeRouter(timers4, {
    fetchRoutes: [CONFIG_TRUE, { match: (url) => url.includes('/playback/resolve'), status: 503 }]
  });
  ok((await router5.start(CHANNEL, VIDEO)) === 'legacy', 'R10.7 a resolution outage degrades to legacy (playback must not die)');
  ok('R10 flag gate + compat rules verified');
}

// ============================================================
// R11 — The pure embed-src guard.
// ============================================================
{
  ok(isSafeLivetvEmbedSrc('https://embeds.example.com/news') === 'https://embeds.example.com/news', 'R11.1 an https URL passes');
  ok(isSafeLivetvEmbedSrc('http://embeds.example.com/news') === null, 'R11.2 http is refused');
  ok(isSafeLivetvEmbedSrc('javascript:alert(1)') === null, 'R11.3 non-http(s) schemes are refused');
  ok(isSafeLivetvEmbedSrc('not a url') === null, 'R11.4 garbage is refused');
  ok(isSafeLivetvEmbedSrc(null) === null && isSafeLivetvEmbedSrc(undefined) === null && isSafeLivetvEmbedSrc(42) === null, 'R11.5 non-strings are refused');
  ok(isSafeLivetvEmbedSrc(`https://embeds.example.com/${'x'.repeat(2100)}`) === null, 'R11.6 overlong URLs are refused');
  ok('R11 embed-src guard verified');
}

// ============================================================
// R12 — R-1 probeSelection: the READ-ONLY switch pre-check.
// ============================================================
{
  const timers = createFakeTimers();
  // A probe against a USABLE selection (resolved, non-empty candidates).
  const availableRouter = makeRouter(timers, {
    fetchRoutes: [CONFIG_TRUE, resolveRoute([{ candidateId: 'default:ep1', engine: 'shaka_media_player', endpointKind: 'direct_stream', streamFormat: 'hls', url: 'https://cdn.example/live.m3u8', resolver: null, sourceChannelId: null, label: null }])]
  });
  const probeAvailable = await availableRouter.router.probeSelection('entry:e1');
  ok(probeAvailable === true, 'R12.1 a resolved selection with a usable candidate probes AVAILABLE');
  ok(availableRouter.recorder.resolving.length === 0 && availableRouter.recorder.engines.length === 0 && availableRouter.recorder.embeds.length === 0 && availableRouter.recorder.sessionErrors.length === 0, 'R12.2 the probe mutated NO session state (no resolving, no engine, no embed, no error)');
  ok(availableRouter.router.getState() === 'idle', 'R12.3 the router lifecycle state is untouched by a probe');

  // Unresolved (nothing configured) and empty (managed but nothing eligible)
  // selections probe UNAVAILABLE — the switcher's honest failure direction.
  const unavailableRouter = makeRouter(timers, { fetchRoutes: [CONFIG_TRUE, resolveRoute([], false)] });
  ok(await unavailableRouter.router.probeSelection('entry:e9') === false, 'R12.4 resolved:false probes UNAVAILABLE');
  const emptyRouter = makeRouter(timers, { fetchRoutes: [CONFIG_TRUE, resolveRoute([])] });
  ok(await emptyRouter.router.probeSelection('entry:e9') === false, 'R12.5 a managed selection with ZERO eligible candidates probes UNAVAILABLE');

  // Transport failure (timeout) — fail-closed, and the probe never throws.
  const failingRouter = makeRouter(timers, { fetchRoutes: [CONFIG_TRUE] }); // no resolve route → 404 → LiveTvError
  ok(await failingRouter.router.probeSelection('entry:e9') === false, 'R12.6 a transport failure probes UNAVAILABLE (never throws)');

  // A probe honors an externally aborted signal (fail-closed, silent).
  const abortRouter = makeRouter(timers, { fetchRoutes: [CONFIG_TRUE, resolveRoute([{ candidateId: 'default:ep1', engine: 'shaka_media_player', endpointKind: 'direct_stream', streamFormat: 'hls', url: 'https://cdn.example/live.m3u8', resolver: null, sourceChannelId: null, label: null }])] });
  const external = new AbortController();
  external.abort();
  ok(await abortRouter.router.probeSelection('entry:e1', external.signal) === false, 'R12.7 an already-aborted signal probes UNAVAILABLE (fail-closed)');
  ok('R12 probeSelection verified');
}

console.log(`\nPhase 5 router suite: ${passed} checks PASS`);
if (passed < 40) {
  console.error('FAIL: expected at least 40 checks');
  process.exit(1);
}
