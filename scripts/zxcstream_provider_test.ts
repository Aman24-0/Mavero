import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { ResolverError } from '$lib/server/resolver/errors';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { TrustedResolutionConfig } from '$lib/server/resolver/types';
import type { PlayerSource } from '$lib/shared/player';
import { ZxcStreamPlayerAdapter } from '$lib/client/player/providers/zxcstream-adapter';
import { ZXCSTREAM_CAPABILITIES, lookupProviderCapabilities, PROVIDER_CAPABILITY_MAP } from '$lib/client/player/capabilities';
import type { PlayerEvent } from '$lib/client/player/events';

// ZXCStream provider tests (2026-10 integration).
//
// Verified contract (the provider's own in-site API documentation on
// https://zxcstream.cc/, extracted from the site's embed builder, fetched
// 2026-10-16):
//   Movie: https://zxcstream.cc/player/movie/{tmdbId}
//   TV:    https://zxcstream.cc/player/tv/{tmdbId}/{season}/{episode}
//   Params: server (favorite server, e.g. 1), color (hex WITHOUT #),
//           dubLang (en|fr|hi|id|pt|ru|es|tl|ta|te|esla|ptbr — "If the
//           requested dubLang is not available, the player falls back to
//           the original audio"), domainAd (intro splash — NOT sent),
//           autoplay (MUTED autoplay — NOT sent), back (shows the provider
//           back button — OMITTED: documented default hides it).
//   NO postMessage protocol, NO startAt/resume parameter documented.
//
// All provider responses are MOCKED — no live third-party dependency.
// Mocked playback is never misrepresented as verified real-world playback.

// --- Minimal window mock (phase3 conventions) ---

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

const messageListeners = new Set<(event: { type: string; origin: string; data: unknown }) => void>();
const computedStyles = new Map<string, string>();
const mockDocument = { documentElement: {} };

const mockWindow = {
  addEventListener: (type: string, listener: (event: never) => void) => {
    if (type === 'message') messageListeners.add(listener as never);
  },
  removeEventListener: (type: string, listener: (event: never) => void) => {
    if (type === 'message') messageListeners.delete(listener as never);
  },
  dispatchEvent: (event: { type: string; origin: string; data: unknown }) => {
    for (const listener of [...messageListeners]) {
      try { listener(event); } catch { /* listeners must never throw */ }
    }
    return true;
  },
  postMessage: () => { /* no-op */ },
  getComputedStyle: () => ({
    getPropertyValue: (name: string) => computedStyles.get(name) ?? '',
  }),
};

(globalThis as unknown as { window: unknown }).window = mockWindow;
(globalThis as unknown as { MessageEvent: unknown }).MessageEvent = MockMessageEvent;
(globalThis as unknown as { document: unknown }).document = mockDocument;

function simulateMessage(origin: string, data: unknown): void {
  mockWindow.dispatchEvent({ type: 'message', origin, data });
}

function collectEvents(adapter: { onEvent: (handler: (event: PlayerEvent) => void) => () => void }): PlayerEvent[] {
  const events: PlayerEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  return events;
}

function makeSource(url: string, overrides: Partial<PlayerSource> = {}): PlayerSource {
  return {
    type: 'embed',
    url,
    providerId: '00000000-0000-4000-8000-00000000zc01',
    sourceId: '00000000-0000-4000-8000-00000000zc02',
    mediaType: 'movie',
    ...overrides,
  };
}

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const ZXC_ORIGIN = 'https://zxcstream.cc';
const MOVIE_URL = `${ZXC_ORIGIN}/player/movie/1184918?dubLang=hi&server=1`;
const TV_URL = `${ZXC_ORIGIN}/player/tv/66732/1/2?dubLang=hi&server=1`;

// ============================================================
// §1 — Capability truth table (conservative black-box embed)
// ============================================================

ok(ZXCSTREAM_CAPABILITIES.progressEvents === false, '§1 progressEvents false (no documented message protocol)');
ok(ZXCSTREAM_CAPABILITIES.startAt === false, '§1 startAt false (no documented resume parameter — never invented)');
ok(ZXCSTREAM_CAPABILITIES.seek === false && ZXCSTREAM_CAPABILITIES.play === false && ZXCSTREAM_CAPABILITIES.pause === false, '§1 no parent commands documented');
ok(ZXCSTREAM_CAPABILITIES.fullscreen === true, '§1 fullscreen (provider embed markup uses allowFullScreen)');
ok(ZXCSTREAM_CAPABILITIES.postMessage === false, '§1 postMessage false (no documented protocol at all)');
ok(lookupProviderCapabilities('zxcstream') === ZXCSTREAM_CAPABILITIES, '§1 capability matrix lookup resolves zxcstream');

// ============================================================
// §2 — canHandle + adapter lifecycle
// ============================================================

const adapter = new ZxcStreamPlayerAdapter();
ok(adapter.canHandle(makeSource(MOVIE_URL)) === true, '§2 canHandle: zxcstream movie player URL');
ok(adapter.canHandle(makeSource(TV_URL)) === true, '§2 canHandle: zxcstream TV player URL');
ok(adapter.canHandle(makeSource('https://vidlink.pro/movie/1')) === false, '§2 canHandle rejects foreign origins');
ok(adapter.canHandle(makeSource('https://zxcstream.cc.evil.test/player/movie/1')) === false, '§2 canHandle rejects suffix-spoofed origins');

adapter.load();
const events = collectEvents(adapter);
// No documented protocol: every message — even from the exact origin — is
// dropped, never normalized, never executed.
simulateMessage(ZXC_ORIGIN, { type: 'ZXC_PROGRESS', currentTime: 30 });
simulateMessage(ZXC_ORIGIN, { type: 'TGFLIX_EVENT', event: 'timeupdate', currentTime: 30 });
simulateMessage(ZXC_ORIGIN, 'arbitrary-string');
simulateMessage('https://evil.example.com', { type: 'ZXC_PROGRESS', currentTime: 30 });
ok(events.length === 0, '§2 NO message is normalized (no documented protocol — nothing fabricated)');
await adapter.destroy();

// ============================================================
// §3 — Runtime theme accent (color, hex WITHOUT #)
// ============================================================

computedStyles.set('--color-primary', '#00ff9c');
ok(adapter.finalizeEmbedUrl?.(MOVIE_URL) === `${MOVIE_URL}&color=00ff9c`, '§3 finalizeEmbedUrl appends the live accent token without #');
computedStyles.set('--color-primary', 'fafafa');
ok(adapter.finalizeEmbedUrl?.(TV_URL) === `${TV_URL}&color=fafafa`, '§3 documented example hex (fafafa) passes through');
computedStyles.set('--color-primary', 'not-a-color');
ok(adapter.finalizeEmbedUrl?.(MOVIE_URL) === null, '§3 invalid accent → null (URL unchanged)');
computedStyles.clear();
// No startAt hook: the adapter does not implement startAtParam.
ok(adapter.startAtParam === undefined, '§3 startAtParam not implemented (no documented resume parameter)');

// ============================================================
// §4 — Server-side template resolution (TrustedResolutionConfig)
// ============================================================

const providerId = '00000000-0000-4000-8000-00000000zc01';
const sourceId = '00000000-0000-4000-8000-00000000zc02';

const zxcCapabilities = {
  movie: true,
  series: true,
  anime: true,
  result_type: 'embed',
  supports_episode: true,
  supports_direct: false,
  supports_server_selection: true,
  automatic_server_fallback: false,
  supports_subtitles: false,
  supports_language_selection: false,
  supports_download: false,
  allow_experimental_playback: true,
  sandbox_policy: 'required',
  allowed_embed_origins: [ZXC_ORIGIN],
};

function zxcConfig(overrides?: { providerEnabled?: boolean; sourceEnabled?: boolean; movieTemplate?: string }): TrustedResolutionConfig {
  return {
    provider: {
      id: providerId,
      name: 'ZXCStream',
      status: 'experimental' as const,
      enabled: overrides?.providerEnabled ?? false,
      integration_type: 'embed' as const,
      adapter_id: 'zxcstream',
      capabilities: zxcCapabilities,
    },
    source: {
      id: sourceId,
      provider_id: providerId,
      name: 'ZXCStream',
      status: 'experimental' as const,
      enabled: overrides?.sourceEnabled ?? false,
      visibility: 'public' as const,
      integration_type: 'embed' as const,
      capabilities: zxcCapabilities,
      movie_template: overrides?.movieTemplate ?? `${ZXC_ORIGIN}/player/movie/{tmdb_id}?dubLang=hi&server=1`,
      series_template: `${ZXC_ORIGIN}/player/tv/{tmdb_id}/{season}/{episode}?dubLang=hi&server=1`,
      anime_template: `${ZXC_ORIGIN}/player/tv/{tmdb_id}/{season}/{episode}?dubLang=hi&server=1`,
      identifier_mode: 'tmdb_id' as const,
      audio_languages: ['multi'],
      subtitle_capability: false,
      quality_capability: [],
    },
  };
}

function content(type: 'movie' | 'series', tmdb?: string): NormalizedMediaItem {
  return {
    id: `zxc-fixture-${tmdb ?? 'none'}`,
    title: 'Fixture title',
    year: 2024,
    type,
    runtime: '120 min',
    rating: 8,
    genres: ['Drama'],
    description: 'Fixture',
    poster: 'https://image.example.test/poster.jpg',
    backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#00ff9c',
    source: { provider: 'tmdb', externalId: tmdb, fetchedAt: new Date().toISOString() },
    externalIds: { tmdb },
  };
}

async function expectError(promise: Promise<unknown>, code: string, label: string) {
  let threw = false;
  try {
    await promise;
  } catch (error) {
    threw = true;
    ok(error instanceof ResolverError && error.code === code, `${label} → ${code} (got ${(error as Error).message})`);
  }
  if (!threw) assert.fail(`${label}: expected ResolverError ${code} but the promise resolved`);
}

{
  await expectError(
    resolveSourceFromConfig({ sourceId, contentId: '1184918', mediaType: 'movie' }, zxcConfig(), content('movie', '1184918')),
    'PROVIDER_DISABLED',
    '§4 seeded (disabled) provider gated',
  );

  const enabled = zxcConfig({ providerEnabled: true, sourceEnabled: true });
  const movie = await resolveSourceFromConfig({ sourceId, contentId: '1184918', mediaType: 'movie' }, enabled, content('movie', '1184918'));
  ok(movie.type === 'embed' && movie.url === MOVIE_URL, '§4 movie template resolves to the EXACT documented URL (dubLang=hi, server=1)');

  const series = await resolveSourceFromConfig({ sourceId, contentId: '66732', mediaType: 'series', season: 1, episode: 2 }, enabled, content('series', '66732'));
  ok(series.type === 'embed' && series.url === TV_URL, '§4 series template resolves to the EXACT documented URL (unpadded, per the docs example)');

  await expectError(
    resolveSourceFromConfig({ sourceId, contentId: 'x', mediaType: 'movie' }, enabled, content('movie')),
    'MISSING_IDENTIFIER',
    '§4 missing TMDB id → MISSING_IDENTIFIER',
  );

  // An IMDb-shaped content id can never leak into the TMDB position: the
  // identifier mode selects EXACTLY identifiers.tmdbId (missing → error).
  await expectError(
    resolveSourceFromConfig({ sourceId, contentId: 'tt1234567', mediaType: 'movie' }, enabled, content('movie')),
    'MISSING_IDENTIFIER',
    '§4 IMDb-shaped id with no TMDB id rejected (no substitution)',
  );

  // Tampered template (foreign origin) rejected by the shared embed guard.
  const tampered = zxcConfig({ providerEnabled: true, sourceEnabled: true, movieTemplate: 'https://evil.example.test/player/movie/{tmdb_id}?dubLang=hi&server=1' });
  await expectError(
    resolveSourceFromConfig({ sourceId, contentId: '1184918', mediaType: 'movie' }, tampered, content('movie', '1184918')),
    'INVALID_SOURCE_URL',
    '§4 tampered/foreign template rejected',
  );

  ok(movie.sandboxPolicy === 'required' && movie.sandboxRuntime?.effectiveSandboxPolicy === 'required', '§4 sandbox policy required (documented default)');
}

// ============================================================
// §5 — Migration contract (ZXCStream half)
// ============================================================

const migration = readFileSync(resolve('supabase/migrations/20261113000000_vixolity_tgvid_zxcstream_providers.sql'), 'utf-8');
ok(migration.includes("'zxcstream'"), '§5 zxcstream provider slug seeded');
ok(migration.includes("'zxcstream-embed'"), '§5 zxcstream source slug seeded');
ok(migration.includes(`'allowed_embed_origins', jsonb_build_array('https://zxcstream.cc')`), '§5 embed origin pinned exactly');
ok(migration.includes('https://zxcstream.cc/player/movie/{tmdb_id}?dubLang=hi&server=1'), '§5 movie template exact');
ok(migration.includes('https://zxcstream.cc/player/tv/{tmdb_id}/{season}/{episode}?dubLang=hi&server=1'), '§5 series template exact');
ok((migration.match(/dubLang=hi/g) ?? []).length >= 6, '§5 dubLang=hi present in all three ZXCStream templates + notes');
// Deliberate omissions verified (documented behaviors).
ok(!/'https:\/\/[^']*\?[^']*domainAd/.test(migration), '§5 NO domainAd splash parameter in any template');
ok(!/'https:\/\/[^']*\?[^']*autoplay=true/.test(migration), '§5 NO muted autoplay in any template');
ok(!/'https:\/\/zxcstream\.cc[^']*\?[^']*back=/.test(migration), '§5 NO back parameter on any ZXCStream template (documented default hides the provider back button)');
ok(migration.includes('domainAd'), '§5 the deliberate domainAd omission IS documented in the notes');
ok(migration.includes("'supports_server_selection', true"), '§5 server selection flag (server=1 seeds the provider-internal default)');
ok(PROVIDER_CAPABILITY_MAP['zxcstream'] === ZXCSTREAM_CAPABILITIES, '§5 capability map key matches the migration adapter_id');

// ============================================================
// Summary
// ============================================================

console.log(`zxcstream_provider_test: ${passed} checks passed`);
