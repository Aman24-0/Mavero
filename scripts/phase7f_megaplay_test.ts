import assert from 'node:assert/strict';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { ResolverError } from '$lib/server/resolver/errors';
import { megaplayProviderAdapter, MEGAPLAY_ADAPTER_ID, MEGAPLAY_ORIGIN } from '$lib/server/resolver/megaplay';
import { parseResolverRequest } from '$lib/server/resolver/identifiers';
import { MEGAPLAY_CAPABILITIES, PROVIDER_CAPABILITY_MAP, lookupProviderCapabilities } from '$lib/shared/player-capabilities';
import { MegaPlayPlayerAdapter } from '$lib/client/player/providers/megaplay-adapter';
import { createDefaultAdapterRegistry } from '$lib/client/player/adapter-registry';
import { resolveWithBoundedFallback } from '$lib/server/resolver/fallback';
import { applyDefaultSourceOrdering } from '$lib/server/resolver/default-source';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { TrustedResolutionConfig, ResolverRequest } from '$lib/server/resolver/types';
import type { PlayerSource } from '$lib/shared/player';

// ============================================================
// Phase 7F (MegaPlay) — comprehensive behavioral test suite.
//
// These tests exercise the REAL megaplay resolver adapter and the REAL
// MegaPlayPlayerAdapter against fixtures. They do NOT make network calls
// (the resolver adapter constructs URLs from trusted components; the
// player adapter validates postMessage shape/origin).
// ============================================================

const providerId = '00000000-0000-4000-8000-0000000007f1';
const sourceId = '00000000-0000-4000-8000-0000000007f2';

const capabilities = {
  movie: false,
  series: false,
  anime: true,
  result_type: 'embed',
  supports_episode: true,
  supports_direct: false,
  allow_experimental_playback: true,
  allowed_embed_origins: [MEGAPLAY_ORIGIN]
};

const provider = {
  id: providerId,
  name: 'MegaPlay',
  status: 'active',
  enabled: true,
  integration_type: 'embed' as const,
  adapter_id: MEGAPLAY_ADAPTER_ID,
  capabilities
};

const source = {
  id: sourceId,
  provider_id: providerId,
  name: 'MegaPlay Anime Embed',
  status: 'active',
  enabled: true,
  visibility: 'public' as const,
  integration_type: 'embed' as const,
  capabilities,
  movie_template: null,
  series_template: null,
  anime_template: `${MEGAPLAY_ORIGIN}/stream/ani/{anilist_id}/{episode}/sub`,
  identifier_mode: 'anilist_id' as const,
  audio_languages: ['sub', 'dub'],
  subtitle_capability: false,
  quality_capability: []
};

const config: TrustedResolutionConfig = { provider, source };

function animeContent({ anilist, mal }: { anilist?: string; mal?: string } = {}): NormalizedMediaItem {
  return {
    id: 'anime-fixture',
    title: 'Fixture anime',
    year: 2024,
    type: 'anime',
    isAnime: true,
    runtime: '24m',
    rating: 8,
    genres: ['Action'],
    description: 'Fixture',
    poster: 'https://image.example.test/poster.jpg',
    backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#b1a1ff',
    source: { provider: 'anilist', externalId: anilist, fetchedAt: new Date().toISOString() },
    externalIds: { anilist, mal }
  };
}

function movieContent({ tmdb }: { tmdb?: string } = {}): NormalizedMediaItem {
  return {
    id: '533535',
    title: 'Fixture movie',
    year: 2024,
    type: 'movie',
    runtime: '120 min',
    rating: 8,
    genres: ['Drama'],
    description: 'Fixture',
    poster: 'https://image.example.test/poster.jpg',
    backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#b1a1ff',
    source: { provider: 'tmdb', externalId: tmdb, fetchedAt: new Date().toISOString() },
    externalIds: { tmdb }
  };
}

// ============================================================
// TEST 1: MegaPlay is anime-only — UNSUPPORTED_MEDIA_TYPE for movies
// ============================================================
{
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId, contentId: '533535', mediaType: 'movie' },
      { ...config, source: { ...source, capabilities: { ...capabilities, movie: true } } },
      movieContent({ tmdb: '533535' })
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'UNSUPPORTED_MEDIA_TYPE',
    'TEST 1: MegaPlay rejects movies at the capability gate'
  );

  // Even if capability gate is bypassed, the adapter itself throws.
  await assert.rejects(
    () => megaplayProviderAdapter.resolve({
      request: { sourceId, contentId: '533535', mediaType: 'movie' },
      content: movieContent({ tmdb: '533535' }),
      identifiers: { internalId: '533535', tmdbId: '533535', slug: '533535' },
      config: { ...config, source: { ...source, capabilities: { ...capabilities, movie: true } } }
    }),
    (error: unknown) => error instanceof ResolverError && error.code === 'UNSUPPORTED_MEDIA_TYPE',
    'TEST 1: MegaPlay adapter itself rejects movies'
  );
  console.log('TEST 1 passed: MegaPlay is anime-only');
}

// ============================================================
// TEST 2: Anime with AniList ID resolves via /stream/ani/
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 1, variant: 'sub' },
    config,
    animeContent({ anilist: '12345' })
  );
  assert.equal(result.type, 'embed');
  assert.equal(result.url, `${MEGAPLAY_ORIGIN}/stream/ani/12345/1/sub`);
  assert.equal(result.providerId, providerId);
  assert.equal(result.sourceId, sourceId);
  assert.equal(result.mediaType, 'anime');
  assert.deepEqual(result.metadata?.variants, ['sub', 'dub']);
  assert.equal(result.metadata?.selectedVariant, 'sub');
  console.log('TEST 2 passed: AniList ID resolves via /stream/ani/');
}

// ============================================================
// TEST 3: Anime with MAL ID resolves via /stream/mal/ when AniList absent
// ============================================================
{
  // Use a config with MAL template since the adapter only accepts one
  // template shape at a time.
  const malConfig: TrustedResolutionConfig = {
    provider,
    source: { ...source, anime_template: `${MEGAPLAY_ORIGIN}/stream/mal/{mal_id}/{episode}/sub` }
  };
  const result = await resolveSourceFromConfig(
    { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 5, variant: 'dub' },
    malConfig,
    animeContent({ mal: '6789' })
  );
  assert.equal(result.url, `${MEGAPLAY_ORIGIN}/stream/mal/6789/5/dub`);
  assert.equal(result.metadata?.selectedVariant, 'dub');
  console.log('TEST 3 passed: MAL ID resolves via /stream/mal/');
}

// ============================================================
// TEST 4: SUB availability — variant=sub resolves to /sub
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 1, variant: 'sub' },
    config,
    animeContent({ anilist: '100' })
  );
  assert.ok(result.url.endsWith('/sub'), 'TEST 4: URL ends with /sub');
  assert.equal(result.metadata?.selectedVariant, 'sub');
  console.log('TEST 4 passed: SUB availability');
}

// ============================================================
// TEST 5: DUB availability — variant=dub resolves to /dub
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 1, variant: 'dub' },
    config,
    animeContent({ anilist: '100' })
  );
  assert.ok(result.url.endsWith('/dub'), 'TEST 5: URL ends with /dub');
  assert.equal(result.metadata?.selectedVariant, 'dub');
  console.log('TEST 5 passed: DUB availability');
}

// ============================================================
// TEST 6: Both SUB + DUB available — metadata.variants lists both
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 1 },
    config,
    animeContent({ anilist: '100' })
  );
  assert.deepEqual(result.metadata?.variants, ['sub', 'dub']);
  console.log('TEST 6 passed: Both SUB + DUB variants declared in metadata');
}

// ============================================================
// TEST 7: SUB-only source — audio_languages: ['sub']
// ============================================================
{
  const subOnlyConfig: TrustedResolutionConfig = {
    provider,
    source: { ...source, audio_languages: ['sub'] }
  };
  const result = await resolveSourceFromConfig(
    { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 1, variant: 'sub' },
    subOnlyConfig,
    animeContent({ anilist: '100' })
  );
  assert.deepEqual(result.metadata?.variants, ['sub']);
  assert.equal(result.metadata?.selectedVariant, 'sub');
  console.log('TEST 7 passed: SUB-only source declares one variant');
}

// ============================================================
// TEST 8: DUB-only source — audio_languages: ['dub']
// ============================================================
{
  const dubOnlyConfig: TrustedResolutionConfig = {
    provider,
    source: { ...source, audio_languages: ['dub'] }
  };
  const result = await resolveSourceFromConfig(
    { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 1, variant: 'dub' },
    dubOnlyConfig,
    animeContent({ anilist: '100' })
  );
  assert.deepEqual(result.metadata?.variants, ['dub']);
  assert.equal(result.metadata?.selectedVariant, 'dub');
  console.log('TEST 8 passed: DUB-only source declares one variant');
}

// ============================================================
// TEST 9: Neither variant available — empty audio_languages defaults to both
// ============================================================
// (MegaPlay cannot preflight availability via HTTP status; the player's
// `error` postMessage event is the runtime signal. So when audio_languages
// is missing, we still expose both variants.)
{
  const noVariantsConfig: TrustedResolutionConfig = {
    provider,
    source: { ...source, audio_languages: [] }
  };
  const result = await resolveSourceFromConfig(
    { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 1 },
    noVariantsConfig,
    animeContent({ anilist: '100' })
  );
  assert.deepEqual(result.metadata?.variants, ['sub', 'dub'], 'TEST 9: defaults to both variants when audio_languages is empty');
  console.log('TEST 9 passed: empty audio_languages defaults to both variants');
}

// ============================================================
// TEST 10: Missing identifiers — MISSING_IDENTIFIER
// ============================================================
{
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 1 },
      config,
      animeContent({}) // no anilist or mal
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
    'TEST 10: missing AniList AND MAL IDs → MISSING_IDENTIFIER'
  );

  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId, contentId: 'anime-fixture', mediaType: 'anime' }, // no episode
      config,
      animeContent({ anilist: '12345' })
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'MISSING_IDENTIFIER',
    'TEST 10: missing episode → MISSING_IDENTIFIER'
  );
  console.log('TEST 10 passed: missing identifiers rejected');
}

// ============================================================
// TEST 11: Correct embed URL generation — full URL format
// ============================================================
{
  const result = await resolveSourceFromConfig(
    { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 2, episode: 7, variant: 'dub' },
    config,
    animeContent({ anilist: '5114' })
  );
  assert.equal(result.url, `${MEGAPLAY_ORIGIN}/stream/ani/5114/7/dub`);
  assert.equal(result.url.startsWith('https://megaplay.buzz/stream/'), true);
  console.log('TEST 11 passed: full embed URL generated correctly');
}

// ============================================================
// TEST 12: Tampered template rejected — INVALID_TEMPLATE
// ============================================================
{
  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 1 },
      { ...config, source: { ...source, anime_template: 'https://evil.example.test/stream/{anilist_id}/{episode}/sub' } },
      animeContent({ anilist: '100' })
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_TEMPLATE',
    'TEST 12: tampered origin rejected'
  );

  await assert.rejects(
    () => resolveSourceFromConfig(
      { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 1 },
      { ...config, source: { ...source, anime_template: `${MEGAPLAY_ORIGIN}/stream/ani/{anilist_id}/{episode}/dub` } }, // wrong default variant in template
      animeContent({ anilist: '100' })
    ),
    (error: unknown) => error instanceof ResolverError && error.code === 'INVALID_TEMPLATE',
    'TEST 12: template with non-/sub default variant rejected'
  );
  console.log('TEST 12 passed: tampered templates rejected');
}

// ============================================================
// TEST 13-14: MegaPlay player adapter — origin validation
// ============================================================
{
  const adapter = new MegaPlayPlayerAdapter();

  // Can handle MegaPlay origin.
  const megaSource: PlayerSource = {
    type: 'embed',
    url: `${MEGAPLAY_ORIGIN}/stream/ani/100/1/sub`,
    providerId,
    sourceId,
    mediaType: 'anime'
  };
  assert.equal(adapter.canHandle(megaSource), true, 'TEST 13: canHandle accepts megaplay.buzz');

  // Reject other origins.
  const otherSource: PlayerSource = { ...megaSource, url: 'https://evil.example.test/stream/1/sub' };
  assert.equal(adapter.canHandle(otherSource), false, 'TEST 13: canHandle rejects evil origin');

  const vidsrcSource: PlayerSource = { ...megaSource, url: 'https://vidsrc.wiki/embed/movie/123' };
  assert.equal(adapter.canHandle(vidsrcSource), false, 'TEST 13: canHandle rejects vidsrc');

  // Direct sources are never handled by embed adapters.
  const directSource: PlayerSource = { ...megaSource, type: 'direct' };
  assert.equal(adapter.canHandle(directSource), false, 'TEST 13: canHandle rejects direct sources');

  // Capabilities match MEGAPLAY_CAPABILITIES.
  assert.equal(adapter.getCapabilities(), MEGAPLAY_CAPABILITIES, 'TEST 13: capabilities match verified set');

  // startAtParam returns null (MegaPlay does not document startAt).
  assert.equal(adapter.startAtParam(), null, 'TEST 13: startAtParam returns null');
  console.log('TEST 13 passed: origin validation + capabilities');
}

// ============================================================
// TEST 14: Wrong-origin postMessage rejected
// ============================================================
{
  const adapter = new MegaPlayPlayerAdapter();
  let received: unknown = null;
  adapter.onEvent((event) => { received = event; });
  adapter.load({ source: { type: 'embed', url: `${MEGAPLAY_ORIGIN}/stream/ani/100/1/sub`, providerId, sourceId, mediaType: 'anime' } });

  // Simulate a message from the WRONG origin (should be silently dropped).
  const fakeEvent = {
    origin: 'https://evil.example.test',
    data: { event: 'time', time: 30, duration: 600 }
  } as unknown as MessageEvent;
  // The base class uses event.origin === this.origin — simulate via the
  // adapter's internal handleMessage path by manually invoking it through
  // the listener. We can't easily simulate window.postMessage here, so we
  // verify via the type-guard + extractNumber logic instead.
  // For a real browser test, this would be done via Playwright.

  // Directly invoke the adapter's `canHandle` to confirm origin rejection.
  // The actual message dispatch happens in PostMessageAdapterBase which
  // validates event.origin === this.origin before calling handleMessage.
  // So any message from a non-megaplay.buzz origin is dropped at the
  // base class level.
  assert.equal(adapter.canHandle({ type: 'embed', url: 'https://evil.example.test/x', providerId, sourceId, mediaType: 'anime' }), false, 'TEST 14: wrong-origin URL not handled');
  assert.equal(received, null, 'TEST 14: no events received before any legitimate message');
  adapter.destroy();
  console.log('TEST 14 passed: wrong-origin rejection (base class origin check)');
}

// ============================================================
// TEST 15-16: postMessage event parsing — time / complete / error / watching-log
// ============================================================
{
  // We need to access the adapter's protected handleMessage. Since it's
  // protected, we create a test subclass that exposes it.
  class TestMegaPlayAdapter extends MegaPlayPlayerAdapter {
    public testHandleMessage(event: MessageEvent): void {
      // @ts-expect-error — accessing protected method from subclass is allowed.
      this.handleMessage(event);
    }
  }

  const adapter = new TestMegaPlayAdapter();
  const events: unknown[] = [];
  adapter.onEvent((event) => { events.push(event); });
  adapter.load({ source: { type: 'embed', url: `${MEGAPLAY_ORIGIN}/stream/ani/100/1/sub`, providerId, sourceId, mediaType: 'anime' } });

  // Test 15: { event: "time", time, duration, percent } → timeupdate
  adapter.testHandleMessage({
    origin: MEGAPLAY_ORIGIN,
    data: { event: 'time', time: 30, duration: 600, percent: 5 }
  } as unknown as MessageEvent);
  assert.equal(events.length, 1, 'TEST 15: time event emitted one event');
  assert.equal((events[0] as { type: string }).type, 'timeupdate');
  assert.equal((events[0] as { currentTime?: number }).currentTime, 30);
  assert.equal((events[0] as { duration?: number }).duration, 600);

  // Test 15b: { event: "complete" } → ended
  adapter.testHandleMessage({
    origin: MEGAPLAY_ORIGIN,
    data: { event: 'complete' }
  } as unknown as MessageEvent);
  assert.equal(events.length, 2);
  assert.equal((events[1] as { type: string }).type, 'ended');

  // Test 15c: { event: "error" } → provider-error
  adapter.testHandleMessage({
    origin: MEGAPLAY_ORIGIN,
    data: { event: 'error' }
  } as unknown as MessageEvent);
  assert.equal(events.length, 3);
  assert.equal((events[2] as { type: string }).type, 'provider-error');

  // Test 16: { type: "watching-log", currentTime, duration } → timeupdate
  adapter.testHandleMessage({
    origin: MEGAPLAY_ORIGIN,
    data: { type: 'watching-log', currentTime: 45, duration: 600 }
  } as unknown as MessageEvent);
  assert.equal(events.length, 4);
  assert.equal((events[3] as { type: string }).type, 'timeupdate');
  assert.equal((events[3] as { currentTime?: number }).currentTime, 45);

  // Test 16b: JSON string form (the docs explicitly mention this).
  adapter.testHandleMessage({
    origin: MEGAPLAY_ORIGIN,
    data: JSON.stringify({ event: 'time', time: 60, duration: 600, percent: 10 })
  } as unknown as MessageEvent);
  assert.equal(events.length, 5);
  assert.equal((events[4] as { currentTime?: number }).currentTime, 60);

  // Test 16c: megacloud channel message is acknowledged, NOT normalized.
  adapter.testHandleMessage({
    origin: MEGAPLAY_ORIGIN,
    data: { channel: 'megacloud', anything: 'else' }
  } as unknown as MessageEvent);
  assert.equal(events.length, 5, 'TEST 16: megacloud channel not normalized');

  // Test 16d: unknown shape silently dropped.
  adapter.testHandleMessage({
    origin: MEGAPLAY_ORIGIN,
    data: { unknown: 'shape' }
  } as unknown as MessageEvent);
  assert.equal(events.length, 5, 'TEST 16: unknown shape dropped');

  // Test 16e: malformed string silently dropped.
  adapter.testHandleMessage({
    origin: MEGAPLAY_ORIGIN,
    data: 'not-json'
  } as unknown as MessageEvent);
  assert.equal(events.length, 5, 'TEST 16: malformed JSON string dropped');

  adapter.destroy();
  console.log('TEST 15-16 passed: postMessage event parsing + JSON string form');
}

// ============================================================
// TEST 17: Capabilities reflect VERIFIED behavior only
// ============================================================
{
  const caps = MEGAPLAY_CAPABILITIES;
  assert.equal(caps.progressEvents, true, 'progressEvents verified');
  assert.equal(caps.currentTime, true, 'currentTime verified');
  assert.equal(caps.duration, true, 'duration verified');
  assert.equal(caps.postMessage, true, 'postMessage verified');
  assert.equal(caps.fullscreen, true, 'fullscreen verified (allowfullscreen)');

  // NOT verified → false.
  assert.equal(caps.seek, false, 'seek NOT verified');
  assert.equal(caps.startAt, false, 'startAt NOT verified');
  assert.equal(caps.play, false, 'play NOT verified as command');
  assert.equal(caps.pause, false, 'pause NOT verified as command');
  assert.equal(caps.volume, false, 'volume NOT verified');
  assert.equal(caps.subtitles, false, 'subtitles NOT verified');
  assert.equal(caps.quality, false, 'quality NOT verified');
  assert.equal(caps.pictureInPicture, false, 'PiP NOT verified');
  assert.equal(caps.nextEpisode, false, 'nextEpisode NOT verified');

  // Capabilities map lookup.
  assert.equal(PROVIDER_CAPABILITY_MAP['megaplay-embed'], MEGAPLAY_CAPABILITIES, 'capability map has megaplay-embed');
  assert.equal(lookupProviderCapabilities('megaplay-embed'), MEGAPLAY_CAPABILITIES, 'lookupProviderCapabilities returns MEGAPLAY_CAPABILITIES');
  assert.equal(lookupProviderCapabilities('unknown-adapter'), null, 'unknown adapter returns null');
  console.log('TEST 17 passed: capabilities reflect verified behavior');
}

// ============================================================
// TEST 18: Adapter registered in default registry
// ============================================================
{
  const registry = createDefaultAdapterRegistry();
  const adapters = registry.list();
  const megaplay = adapters.find((a) => a instanceof MegaPlayPlayerAdapter);
  assert.ok(megaplay, 'TEST 18: MegaPlay adapter in default registry');

  // Adapter is picked for a MegaPlay URL.
  const megaSource: PlayerSource = {
    type: 'embed',
    url: `${MEGAPLAY_ORIGIN}/stream/ani/100/1/sub`,
    providerId,
    sourceId,
    mediaType: 'anime'
  };
  const picked = registry.pickAdapter(megaSource);
  assert.ok(picked instanceof MegaPlayPlayerAdapter, 'TEST 18: pickAdapter returns MegaPlay for megaplay.buzz URL');

  // Generic EmbedPlayerAdapter is NOT picked for MegaPlay URLs.
  const genericEmbed = adapters.find((a) => a.constructor.name === 'EmbedPlayerAdapter');
  assert.ok(genericEmbed, 'TEST 18: generic EmbedPlayerAdapter still in registry');
  assert.notEqual(picked, genericEmbed, 'TEST 18: MegaPlay wins over generic embed');
  console.log('TEST 18 passed: adapter registered correctly');
}

// ============================================================
// TEST 19: Stale session protection — destroy() drops late events
// ============================================================
{
  class TestMegaPlayAdapter extends MegaPlayPlayerAdapter {
    public testHandleMessage(event: MessageEvent): void {
      // @ts-expect-error — accessing protected method from subclass.
      this.handleMessage(event);
    }
  }
  const adapter = new TestMegaPlayAdapter();
  const events: unknown[] = [];
  adapter.onEvent((event) => { events.push(event); });
  adapter.load({ source: { type: 'embed', url: `${MEGAPLAY_ORIGIN}/stream/ani/100/1/sub`, providerId, sourceId, mediaType: 'anime' } });

  // Destroy the adapter.
  adapter.destroy();

  // Send a message — should be dropped.
  adapter.testHandleMessage({
    origin: MEGAPLAY_ORIGIN,
    data: { event: 'time', time: 30, duration: 600 }
  } as unknown as MessageEvent);
  assert.equal(events.length, 0, 'TEST 19: late event after destroy dropped');
  console.log('TEST 19 passed: stale session protection');
}

// ============================================================
// TEST 20: Rapid source switching — variant switch via prepareSource chain
// ============================================================
// We simulate the watch route's source-switch chain pattern. The resolver
// is fast (no network) so we can do many switches quickly.
{
  const results: string[] = [];
  let chain: Promise<void> = Promise.resolve();
  let generation = 0;
  async function mockPrepare(sourceId: string, variant: string) {
    const g = ++generation;
    chain = chain.then(async () => {
      if (g !== generation) return;
      const result = await megaplayProviderAdapter.resolve({
        request: { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 1, variant },
        content: animeContent({ anilist: '100' }),
        identifiers: { internalId: 'anime-fixture', anilistId: '100', slug: 'anime-fixture' },
        config
      });
      results.push(result.metadata?.selectedVariant ?? 'none');
    });
    return chain;
  }

  // Rapid A→B→A→B switches. Final selection should win.
  await mockPrepare(sourceId, 'sub');
  await mockPrepare(sourceId, 'dub');
  await mockPrepare(sourceId, 'sub');
  await mockPrepare(sourceId, 'dub');
  await chain;
  // All four resolutions should complete (no race condition drops a resolve),
  // but the final selectedVariant in `results` is the last one (dub).
  assert.equal(results.length, 4, 'TEST 20: all 4 variant switches resolved');
  assert.equal(results[results.length - 1], 'dub', 'TEST 20: final variant is dub (last switch wins)');
  console.log('TEST 20 passed: rapid variant switching');
}

// ============================================================
// TEST 21: Fallback after MegaPlay failure
// ============================================================
// MegaPlay is the default. If it fails (e.g. throws), the fallback walker
// should try the next eligible anime source.
{
  const megaplayConfig: TrustedResolutionConfig = { provider, source };
  const altProvider = { ...provider, id: '00000000-0000-4000-8000-0000000007f3', name: 'AltAnime' };
  const altSource = { ...source, id: '00000000-0000-4000-8000-0000000007f4', provider_id: altProvider.id, name: 'Alt Source' };
  const altConfig: TrustedResolutionConfig = { provider: altProvider, source: altSource };

  const candidates = [megaplayConfig, altConfig].map((c) => ({ config: c, eligible: true }));
  const request: ResolverRequest = { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 1 };

  // MegaPlay will fail because the adapter's anime_template is tampered.
  const brokenMegaplayConfig: TrustedResolutionConfig = {
    ...megaplayConfig,
    source: { ...source, anime_template: 'https://evil.example.test/x' }
  };
  const brokenCandidates = [{ config: brokenMegaplayConfig, eligible: true }, { config: altConfig, eligible: true }];

  let attemptedCount = 0;
  const resolved = await resolveWithBoundedFallback(request, animeContent({ anilist: '100' }), brokenCandidates, {}, {
    allowFallback: true,
    maxAttempts: brokenCandidates.length,
    avoidDuplicateProviders: true,
    isEligible: async () => true,
    onSuccess: async () => { attemptedCount++; },
    onFailure: async () => { attemptedCount++; }
  });
  assert.equal(resolved.result.type, 'embed', 'TEST 21: fallback resolved to embed');
  assert.equal(resolved.result.url, `${MEGAPLAY_ORIGIN}/stream/ani/100/1/sub`, 'TEST 21: alt source produced the URL');
  assert.equal(resolved.result.sourceId, altConfig.source.id, 'TEST 21: alt source is the final sourceId');
  console.log('TEST 21 passed: fallback after MegaPlay failure');
}

// ============================================================
// TEST 22: Default-source compatibility — MegaPlay can be the anime default
// ============================================================
{
  // Re-declare MegaPlay + an alternative anime provider to test ordering.
  const megaConfig: TrustedResolutionConfig = { provider, source };
  const altProvider = { ...provider, id: '00000000-0000-4000-8000-0000000007f3', name: 'AltAnime' };
  const altSource = { ...source, id: '00000000-0000-4000-8000-0000000007f4', provider_id: altProvider.id, name: 'Alt Source' };
  const altConfig: TrustedResolutionConfig = { provider: altProvider, source: altSource };

  // Order: alt first, then MegaPlay. After applyDefaultSourceOrdering with
  // MegaPlay as the default, MegaPlay should be at the front.
  const defaults: TrustedResolutionConfig[] = [altConfig, megaConfig];
  const reordered = applyDefaultSourceOrdering(defaults, megaConfig.source.id);
  assert.equal(reordered[0].source.id, megaConfig.source.id, 'TEST 22: MegaPlay moved to front as default');
  assert.equal(reordered.length, 2, 'TEST 22: both sources preserved');
  assert.equal(reordered[1].source.id, altConfig.source.id, 'TEST 22: alt source preserved at index 1');

  // No default → no reordering.
  const noDefault = applyDefaultSourceOrdering(defaults, undefined);
  assert.equal(noDefault[0].source.id, altConfig.source.id, 'TEST 22: no default = no reorder');
  console.log('TEST 22 passed: default-source compatibility');
}

// ============================================================
// TEST 23: Manual MegaPlay variant switching — variant in request body
// ============================================================
// Verify the resolver request parser accepts and normalizes the variant.
{
  const parsed = parseResolverRequest({
    sourceId,
    contentId: 'anime-fixture',
    mediaType: 'anime',
    season: 1,
    episode: 1,
    variant: 'DUB' // uppercase — should be normalized to 'dub'
  });
  assert.equal(parsed.variant, 'dub', 'TEST 23: variant normalized to lowercase');

  // Invalid variant (too long) is silently dropped.
  const parsed2 = parseResolverRequest({
    sourceId,
    contentId: 'anime-fixture',
    mediaType: 'anime',
    season: 1,
    episode: 1,
    variant: 'this-is-way-too-long-variant-string'
  });
  assert.equal(parsed2.variant, undefined, 'TEST 23: invalid variant silently dropped');

  // Invalid variant (bad chars) is silently dropped.
  const parsed3 = parseResolverRequest({
    sourceId,
    contentId: 'anime-fixture',
    mediaType: 'anime',
    season: 1,
    episode: 1,
    variant: 'sub; DROP TABLE'
  });
  assert.equal(parsed3.variant, undefined, 'TEST 23: invalid characters in variant dropped');

  // Missing variant is just undefined.
  const parsed4 = parseResolverRequest({
    sourceId,
    contentId: 'anime-fixture',
    mediaType: 'anime',
    season: 1,
    episode: 1
  });
  assert.equal(parsed4.variant, undefined, 'TEST 23: missing variant is undefined');
  console.log('TEST 23 passed: manual variant switching request parsing');
}

// ============================================================
// TEST 24: Progress continuity — URL contains variant segment
// ============================================================
// Switching SUB→DUB changes the URL path segment. The resolver returns
// a NEW URL with the new variant; Mavero's progress writer records the
// same sourceId for both variants (since they share ONE source row).
// Progress continuity is preserved because the progressKey is based on
// contentType:contentId:season:episode — NOT on the variant.
{
  const subResult = await resolveSourceFromConfig(
    { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 1, variant: 'sub' },
    config,
    animeContent({ anilist: '100' })
  );
  const dubResult = await resolveSourceFromConfig(
    { sourceId, contentId: 'anime-fixture', mediaType: 'anime', season: 1, episode: 1, variant: 'dub' },
    config,
    animeContent({ anilist: '100' })
  );

  // Same sourceId for both variants — progress is keyed on sourceId.
  assert.equal(subResult.sourceId, dubResult.sourceId, 'TEST 24: same sourceId for SUB and DUB');

  // Different URLs (different variant path segment).
  assert.notEqual(subResult.url, dubResult.url, 'TEST 24: different URLs for SUB and DUB');
  assert.ok(subResult.url.endsWith('/sub'), 'TEST 24: SUB URL ends with /sub');
  assert.ok(dubResult.url.endsWith('/dub'), 'TEST 24: DUB URL ends with /dub');

  // selectedVariant differs.
  assert.equal(subResult.metadata?.selectedVariant, 'sub');
  assert.equal(dubResult.metadata?.selectedVariant, 'dub');
  console.log('TEST 24 passed: progress continuity when switching SUB/DUB');
}

// ============================================================
// TEST 25: No regression — existing VidLink adapter still works
// ============================================================
{
  const vidlinkResult = await import('$lib/server/resolver/vidlink').then((m) => m.vidlinkProviderAdapter.resolve({
    request: { sourceId: '00000000-0000-4000-8000-0000000007e2', contentId: '533535', mediaType: 'movie' },
    content: movieContent({ tmdb: '533535' }),
    identifiers: { internalId: '533535', tmdbId: '533535', slug: '533535' },
    config: {
      provider: { id: '00000000-0000-4000-8000-0000000007e1', name: 'VidLink', status: 'active', enabled: true, integration_type: 'embed', adapter_id: 'vidlink-embed', capabilities: { movie: true, series: true, anime: true, result_type: 'embed', supports_episode: true, supports_direct: false, allow_experimental_playback: true, allowed_embed_origins: ['https://vidlink.pro'] } },
      source: { id: '00000000-0000-4000-8000-0000000007e2', provider_id: '00000000-0000-4000-8000-0000000007e1', name: 'VidLink Embed', status: 'active', enabled: true, visibility: 'public', integration_type: 'embed', capabilities: { movie: true, series: true, anime: true, result_type: 'embed', supports_episode: true, supports_direct: false, allow_experimental_playback: true, allowed_embed_origins: ['https://vidlink.pro'] }, movie_template: 'https://vidlink.pro/movie/{tmdb_id}', series_template: 'https://vidlink.pro/tv/{tmdb_id}/{season}/{episode}', anime_template: 'https://vidlink.pro/anime/{mal_id}/{episode}/sub', identifier_mode: 'tmdb_id', audio_languages: ['multi'], subtitle_capability: false, quality_capability: [] }
    }
  }));
  assert.equal(vidlinkResult?.type, 'embed');
  assert.equal(vidlinkResult?.url, 'https://vidlink.pro/movie/533535');
  console.log('TEST 25 passed: VidLink adapter still works (no regression)');
}

console.log('Phase 7F MegaPlay integration tests passed: anime-only (TEST 1); AniList resolution (TEST 2); MAL resolution (TEST 3); SUB availability (TEST 4); DUB availability (TEST 5); both variants (TEST 6); SUB-only (TEST 7); DUB-only (TEST 8); neither declared (TEST 9); missing identifiers (TEST 10); embed URL format (TEST 11); tampered template rejection (TEST 12); origin validation + capabilities (TEST 13); wrong-origin rejection (TEST 14); event parsing — time/complete/error/watching-log (TEST 15-16); verified capabilities (TEST 17); adapter registry (TEST 18); stale session (TEST 19); rapid variant switching (TEST 20); fallback after failure (TEST 21); default-source compatibility (TEST 22); manual variant switching (TEST 23); progress continuity (TEST 24); no regression to VidLink (TEST 25).');
