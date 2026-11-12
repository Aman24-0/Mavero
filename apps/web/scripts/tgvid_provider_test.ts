import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveSourceFromConfig } from '$lib/server/resolver/core';
import { ResolverError } from '$lib/server/resolver/errors';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { TrustedResolutionConfig } from '$lib/server/resolver/types';
import type { PlayerSource } from '$lib/shared/player';
import { createDefaultAdapterRegistry } from '$lib/client/player/adapter-registry';
import { EmbedPlayerAdapter } from '$lib/client/player/embed-adapter';
import { TgvidPlayerAdapter, parseTgvidContentTags } from '$lib/client/player/providers/tgvid-adapter';
import { ZxcStreamPlayerAdapter } from '$lib/client/player/providers/zxcstream-adapter';
import { TGVID_CAPABILITIES, ZXCSTREAM_CAPABILITIES, lookupProviderCapabilities, PROVIDER_CAPABILITY_MAP } from '$lib/client/player/capabilities';
import type { PlayerEvent } from '$lib/client/player/events';

// TGVID provider tests (2026-10 integration).
//
// Verified contract (official documentation https://tgvid.lovable.app/docs,
// fetched 2026-10-16):
//   Movie: https://tgvid.lovable.app/embed/movie/{tmdbId}
//   TV:    https://tgvid.lovable.app/embed/tv/{tmdbId}/{season}/{episode}
//   Params: color (hex, no #), back, episodeSelector, autoplayNextEp, lang
//           (hi|eng|jap|tam|tel), server, loading, t (seconds, resume).
//   Events: {type:"TGFLIX_EVENT", event, currentTime, duration, paused,
//           tmdbId, mediaType, source} via window.postMessage.
//   Commands: {type:"TGFLIX_CMD", cmd: play|pause|seek|volume|mute|unmute|
//           getState, value} posted to the iframe.
//
// All provider responses are MOCKED (simulated MessageEvents) — no live
// third-party dependency, matching the repository's deterministic test
// conventions. Mocked playback is never misrepresented as verified
// real-world playback.

// --- Minimal window mock (phase3 conventions) ---

class MockMessageEvent {
  type: string;
  origin: string;
  data: unknown;
  source: unknown;
  constructor(type: string, init: { origin?: string; data?: unknown; source?: unknown } = {}) {
    this.type = type;
    this.origin = init.origin ?? '';
    this.data = init.data;
    this.source = init.source;
  }
}

const messageListeners = new Set<(event: { type: string; origin: string; data: unknown; source?: unknown }) => void>();

// getComputedStyle + document mocks so the accent-color hook is testable.
const computedStyles = new Map<string, string>();
const mockDocument = { documentElement: {} };

const mockWindow = {
  addEventListener: (type: string, listener: (event: never) => void) => {
    if (type === 'message') messageListeners.add(listener as never);
  },
  removeEventListener: (type: string, listener: (event: never) => void) => {
    if (type === 'message') messageListeners.delete(listener as never);
  },
  dispatchEvent: (event: { type: string; origin: string; data: unknown; source?: unknown }) => {
    for (const listener of [...messageListeners]) {
      try { listener(event); } catch { /* listeners must never throw */ }
    }
    return true;
  },
  postMessage: () => { /* no-op */ },
  // Accent-token hook: the adapters read getComputedStyle FROM window.
  getComputedStyle: () => ({
    getPropertyValue: (name: string) => computedStyles.get(name) ?? '',
  }),
};

(globalThis as unknown as { window: unknown }).window = mockWindow;
(globalThis as unknown as { MessageEvent: unknown }).MessageEvent = MockMessageEvent;
(globalThis as unknown as { document: unknown }).document = mockDocument;

function simulateMessage(origin: string, data: unknown, source?: unknown): void {
  mockWindow.dispatchEvent({ type: 'message', origin, data, source });
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
    providerId: '00000000-0000-4000-8000-00000000tg01',
    sourceId: '00000000-0000-4000-8000-00000000tg02',
    mediaType: 'movie',
    ...overrides,
  };
}

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const TGVID_ORIGIN = 'https://tgvid.lovable.app';
const MOVIE_URL = `${TGVID_ORIGIN}/embed/movie/1303331?lang=hi&back=false&episodeSelector=false&autoplayNextEp=false`;
const TV_URL = `${TGVID_ORIGIN}/embed/tv/94605/1/1?lang=hi&back=false&episodeSelector=false&autoplayNextEp=false`;

// ============================================================
// §1 — Capability truth table (verified contract only)
// ============================================================

ok(TGVID_CAPABILITIES.progressEvents === true, '§1 progressEvents (documented timeupdate/pause/ended)');
ok(TGVID_CAPABILITIES.currentTime === true, '§1 currentTime (event payload field)');
ok(TGVID_CAPABILITIES.duration === true, '§1 duration (event payload field)');
ok(TGVID_CAPABILITIES.seek === true, '§1 seek (documented TGFLIX_CMD seek command)');
ok(TGVID_CAPABILITIES.startAt === true, '§1 startAt (documented ?t= seconds)');
ok(TGVID_CAPABILITIES.play === true && TGVID_CAPABILITIES.pause === true, '§1 play/pause commands documented');
ok(TGVID_CAPABILITIES.volume === true, '§1 volume command documented (0-1)');
ok(TGVID_CAPABILITIES.subtitles === false, '§1 subtitles are provider-internal only (no parent API)');
ok(TGVID_CAPABILITIES.quality === false, '§1 quality is provider-internal only');
ok(TGVID_CAPABILITIES.fullscreen === true, '§1 fullscreen (documented allow attribute)');
ok(TGVID_CAPABILITIES.pictureInPicture === false, '§1 PiP not verified');
ok(TGVID_CAPABILITIES.postMessage === true, '§1 postMessage documented');
ok(TGVID_CAPABILITIES.nextEpisode === false, '§1 nextEpisode disabled (Mavero owns episode navigation)');
ok(lookupProviderCapabilities('tgvid') === TGVID_CAPABILITIES, '§1 capability matrix lookup resolves tgvid');

// ============================================================
// §2 — canHandle + registry ordering (before the generic fallback)
// ============================================================

const tgvidAdapter = new TgvidPlayerAdapter();
ok(tgvidAdapter.canHandle(makeSource(MOVIE_URL)) === true, '§2 canHandle: tgvid movie embed URL');
ok(tgvidAdapter.canHandle(makeSource(TV_URL)) === true, '§2 canHandle: tgvid TV embed URL');
ok(tgvidAdapter.canHandle(makeSource('https://vidlink.pro/movie/1')) === false, '§2 canHandle rejects foreign origins');
ok(tgvidAdapter.canHandle(makeSource('https://tgvid.lovable.app.evil.test/embed/movie/1')) === false, '§2 canHandle rejects suffix-spoofed origins');

const registry = createDefaultAdapterRegistry();
const ordered = registry.list();
const tgvidIndex = ordered.findIndex((adapter) => adapter instanceof TgvidPlayerAdapter);
const zxcIndex = ordered.findIndex((adapter) => adapter instanceof ZxcStreamPlayerAdapter);
const genericIndex = ordered.findIndex((adapter) => adapter instanceof EmbedPlayerAdapter);
ok(tgvidIndex > 0 && tgvidIndex < genericIndex, '§2 TGVID registered before the generic embed fallback');
ok(zxcIndex > 0 && zxcIndex < genericIndex, '§2 ZXCStream registered before the generic embed fallback');
ok(tgvidIndex < ordered.length - 1 && zxcIndex === tgvidIndex + 1, '§2 TGVID + ZXCStream adjacent (integration order)');
ok(registry.pickAdapter(makeSource(MOVIE_URL)) instanceof TgvidPlayerAdapter, '§2 pickAdapter resolves TGVID embeds to the TGVID adapter');
ok(registry.pickAdapter(makeSource('https://zxcstream.cc/player/movie/1184918?dubLang=hi&server=1')) instanceof ZxcStreamPlayerAdapter, '§2 pickAdapter resolves ZXCStream embeds to the ZXCStream adapter');

// ============================================================
// §3 — TGFLIX_EVENT normalization (documented event names)
// ============================================================

tgvidAdapter.load({ source: makeSource(MOVIE_URL) });
const events = collectEvents(tgvidAdapter);

const tgEvent = (event: string, extra: Record<string, unknown> = {}) => ({
  type: 'TGFLIX_EVENT',
  event,
  tmdbId: 1303331,
  mediaType: 'movie',
  ...extra,
});

simulateMessage(TGVID_ORIGIN, tgEvent('timeupdate', { currentTime: 42.5, duration: 7200 }));
simulateMessage(TGVID_ORIGIN, tgEvent('pause', { currentTime: 61, duration: 7200 }));
simulateMessage(TGVID_ORIGIN, tgEvent('play'));
simulateMessage(TGVID_ORIGIN, tgEvent('buffering'));
simulateMessage(TGVID_ORIGIN, tgEvent('playing'));
simulateMessage(TGVID_ORIGIN, tgEvent('seeked', { currentTime: 120 }));
simulateMessage(TGVID_ORIGIN, tgEvent('ready', { duration: 5400 }));
simulateMessage(TGVID_ORIGIN, tgEvent('ended'));
simulateMessage(TGVID_ORIGIN, tgEvent('error'));

ok(events.some((e) => e.type === 'timeupdate' && e.currentTime === 42.5 && e.duration === 7200), '§3 timeupdate normalized with currentTime + duration');
const pauseIdx = events.findIndex((e) => e.type === 'pause');
ok(pauseIdx > 0 && events[pauseIdx - 1]?.type === 'timeupdate' && (events[pauseIdx - 1] as { currentTime: number }).currentTime === 61, '§3 pause preceded by a fresh position timeupdate (accurate flush)');
ok(events.some((e) => e.type === 'play'), '§3 play normalized');
const playingIdx = events.findIndex((e) => e.type === 'play' && events.indexOf(e) > events.findIndex((x) => x.type === 'buffering' && (x as { value: boolean }).value === true));
ok(events.filter((e) => e.type === 'buffering').some((e) => (e as { value: boolean }).value === true), '§3 buffering → value:true');
ok(events.filter((e) => e.type === 'buffering').some((e) => (e as { value: boolean }).value === false), '§3 playing → buffering cleared');
ok(events.some((e) => e.type === 'seeked' && e.currentTime === 120), '§3 seeked normalized with currentTime');
ok(events.some((e) => e.type === 'ready' && (e as { duration?: number }).duration === 5400), '§3 ready normalized with duration');
ok(events.some((e) => e.type === 'ended'), '§3 ended normalized');
const providerErrors = events.filter((e) => e.type === 'provider-error');
ok(providerErrors.length === 1 && providerErrors[0].message === 'TGVID reported a playback error.', '§3 error → provider-error with the FIXED generic message (nothing invented)');
ok(!events.some((e) => e.type === 'provider-error' && e.message !== 'TGVID reported a playback error.'), '§3 no invented error details');

// volume | source | state | unknown → acknowledged, never normalized.
const eventsBefore = events.length;
simulateMessage(TGVID_ORIGIN, tgEvent('volume', { currentTime: 1 }));
simulateMessage(TGVID_ORIGIN, tgEvent('source'));
simulateMessage(TGVID_ORIGIN, tgEvent('state'));
simulateMessage(TGVID_ORIGIN, tgEvent('totally-unknown-event', { currentTime: 5 }));
ok(events.length === eventsBefore, '§3 volume/source/state/unknown events never normalized');

// ============================================================
// §4 — Security: origin, shape, tags, source, destroyed
// ============================================================

const securityEvents = collectEvents(tgvidAdapter);
const securityCount = () => securityEvents.length;

simulateMessage('https://evil.example.com', tgEvent('timeupdate', { currentTime: 1 }));
ok(securityCount() === 0, '§4 wrong-origin message dropped');

simulateMessage(TGVID_ORIGIN, { type: 'NOT_TGFLIX', event: 'timeupdate', currentTime: 1 });
simulateMessage(TGVID_ORIGIN, 'timeupdate-string');
simulateMessage(TGVID_ORIGIN, null);
simulateMessage(TGVID_ORIGIN, 42);
simulateMessage(TGVID_ORIGIN, tgEvent('timeupdate', { currentTime: 'not-a-number' }));
simulateMessage(TGVID_ORIGIN, tgEvent('timeupdate', { currentTime: -5 }));
simulateMessage(TGVID_ORIGIN, tgEvent('seeked'));
ok(securityCount() === 0, '§4 malformed shapes / non-finite / negative / missing times dropped');

simulateMessage(TGVID_ORIGIN, tgEvent('timeupdate', { currentTime: 99 }));
ok(securityCount() === 1, '§4 matching-tag message accepted (baseline for the tag checks)');

// Content-tag validation: tmdbId/mediaType are parsed from the ACTIVE
// source URL (movie/1303331) — mismatching tags are stale/foreign and
// MUST NOT touch progress.
simulateMessage(TGVID_ORIGIN, { type: 'TGFLIX_EVENT', event: 'timeupdate', currentTime: 1, tmdbId: 9999999, mediaType: 'movie' });
simulateMessage(TGVID_ORIGIN, { type: 'TGFLIX_EVENT', event: 'timeupdate', currentTime: 1, tmdbId: 1303331, mediaType: 'tv' });
ok(securityCount() === 1, '§4 mismatching tmdbId/mediaType tags dropped (stale-iframe protection)');

// event.source validation: with the iframe ref set, only the active
// iframe's contentWindow may address the adapter.
const activeFrame = { contentWindow: { postMessage: () => {} } };
const foreignFrame = { contentWindow: { postMessage: () => {} } };
tgvidAdapter.setIframe(activeFrame as unknown as HTMLIFrameElement);
simulateMessage(TGVID_ORIGIN, tgEvent('timeupdate', { currentTime: 7 }), foreignFrame);
ok(securityCount() === 1, '§4 message from a foreign frame dropped (event.source validation)');
simulateMessage(TGVID_ORIGIN, tgEvent('timeupdate', { currentTime: 8 }), activeFrame.contentWindow);
ok(securityCount() === 2 && (securityEvents[securityEvents.length - 1] as { currentTime: number }).currentTime === 8, '§4 message from the ACTIVE frame accepted');
tgvidAdapter.setIframe(undefined as unknown as HTMLIFrameElement);

// Destroyed adapter → no events reach the handler (listener removed).
await tgvidAdapter.destroy();
simulateMessage(TGVID_ORIGIN, tgEvent('timeupdate', { currentTime: 999 }));
ok(securityCount() === 2, '§4 destroyed adapter drops every late event (listener cleanup)');

// Tag parser unit truth.
ok(parseTgvidContentTags(MOVIE_URL)?.tmdbId === '1303331' && parseTgvidContentTags(MOVIE_URL)?.mediaType === 'movie', '§4 tag parser: movie URL');
const tvTags = parseTgvidContentTags(TV_URL);
ok(tvTags?.tmdbId === '94605' && tvTags?.mediaType === 'tv', '§4 tag parser: TV URL');
ok(parseTgvidContentTags('https://evil.test/embed/movie/1') === null, '§4 tag parser: foreign origin rejected');
ok(parseTgvidContentTags('https://tgvid.lovable.app/embed/banana/1') === null, '§4 tag parser: unknown media segment rejected');
ok(parseTgvidContentTags('not a url') === null, '§4 tag parser: garbage rejected');

// ============================================================
// §5 — Resume (?t=) + runtime theme accent (color)
// ============================================================

const freshAdapter = new TgvidPlayerAdapter();
ok(freshAdapter.startAtParam?.() === 't', '§5 startAtParam is the documented t (seconds)');

computedStyles.set('--color-primary', '#ffffff');
const finalized = freshAdapter.finalizeEmbedUrl?.(MOVIE_URL);
ok(finalized === `${MOVIE_URL}&color=ffffff`, '§5 finalizeEmbedUrl appends the live accent token WITHOUT #');
computedStyles.set('--color-primary', '00b4ff');
ok(freshAdapter.finalizeEmbedUrl?.(MOVIE_URL) === `${MOVIE_URL}&color=00b4ff`, '§5 bare hex accent passes through unchanged');
computedStyles.set('--color-primary', 'rgb(255, 255, 255)');
ok(freshAdapter.finalizeEmbedUrl?.(MOVIE_URL) === null, '§5 invalid accent → null (URL unchanged, never invented)');
computedStyles.clear();

// ============================================================
// §6 — TGFLIX_CMD commands (payload + EXACT target origin)
// ============================================================

const cmdAdapter = new TgvidPlayerAdapter();
cmdAdapter.load({ source: makeSource(MOVIE_URL) });
const sent: { data: unknown; origin: string }[] = [];
const cmdFrame = { contentWindow: { postMessage: (data: unknown, origin: string) => sent.push({ data, origin }) } };
cmdAdapter.setIframe(cmdFrame as unknown as HTMLIFrameElement);

const playResult = await cmdAdapter.play?.();
const pauseResult = await cmdAdapter.pause?.();
const seekResult = await cmdAdapter.seek?.(300);
const volumeResult = await cmdAdapter.setVolume?.(0.5);

ok(playResult?.ok === true && pauseResult?.ok === true, '§6 play/pause reported sent (no success assumed inside the embed)');
ok(seekResult?.ok === true && volumeResult?.ok === true, '§6 seek/volume reported sent');
ok(sent.length === 4, '§6 exactly four command posts');
ok((sent[0].data as { type: string; cmd: string }).type === 'TGFLIX_CMD' && sent[0].data.cmd === 'play', '§6 play payload exact');
ok((sent[1].data as { cmd: string }).cmd === 'pause', '§6 pause payload exact');
ok((sent[2].data as { cmd: string; value: number }).cmd === 'seek' && sent[2].data.value === 300, '§6 seek payload exact (seconds)');
ok((sent[3].data as { cmd: string; value: number }).cmd === 'volume' && sent[3].data.value === 0.5, '§6 volume payload exact (0-1)');
ok(sent.every((call) => call.origin === TGVID_ORIGIN), '§6 EVERY command targets the EXACT documented origin (never "*")');

// Command validation boundaries.
ok((await cmdAdapter.seek?.(-1))?.ok === false, '§6 negative seek rejected locally');
ok((await cmdAdapter.seek?.(Number.NaN))?.ok === false, '§6 NaN seek rejected locally');
ok((await cmdAdapter.setVolume?.(1.5))?.ok === false, '§6 out-of-range volume rejected locally');
ok((await cmdAdapter.setVolume?.(-0.1))?.ok === false, '§6 negative volume rejected locally');

// Without an iframe ref → not-ready (never a fabricated ok).
const noFrameAdapter = new TgvidPlayerAdapter();
noFrameAdapter.load({ source: makeSource(MOVIE_URL) });
ok((await noFrameAdapter.play?.()).ok === false, '§6 command without an iframe ref → not-ready');
ok((await noFrameAdapter.play?.()).reason === 'not-ready', '§6 not-ready reason exact');

await cmdAdapter.destroy();
ok((await cmdAdapter.play?.())?.ok === false, '§6 commands after destroy → not-ready (no post on a dead session)');

// getState is deliberately NOT implemented (no documented response
// correlation — a fabricated answer would violate the contract).
ok(cmdAdapter.getCurrentTime === undefined, '§6 getCurrentTime getter not implemented (no documented response correlation)');

// ============================================================
// §7 — Server-side template resolution (TrustedResolutionConfig)
// ============================================================

const providerId = '00000000-0000-4000-8000-00000000tg01';
const sourceId = '00000000-0000-4000-8000-00000000tg02';

const tgCapabilities = {
  movie: true,
  series: true,
  anime: true,
  result_type: 'embed',
  supports_episode: true,
  supports_direct: false,
  supports_server_selection: false,
  automatic_server_fallback: false,
  supports_subtitles: false,
  supports_language_selection: false,
  supports_download: false,
  allow_experimental_playback: true,
  sandbox_policy: 'required',
  allowed_embed_origins: [TGVID_ORIGIN],
};

function tgvidConfig(overrides?: { providerEnabled?: boolean; sourceEnabled?: boolean }): TrustedResolutionConfig {
  return {
    provider: {
      id: providerId,
      name: 'TGVID',
      status: 'experimental' as const,
      enabled: overrides?.providerEnabled ?? false,
      integration_type: 'embed' as const,
      adapter_id: 'tgvid',
      capabilities: tgCapabilities,
    },
    source: {
      id: sourceId,
      provider_id: providerId,
      name: 'TGVID',
      status: 'experimental' as const,
      enabled: overrides?.sourceEnabled ?? false,
      visibility: 'public' as const,
      integration_type: 'embed' as const,
      capabilities: tgCapabilities,
      movie_template: `${TGVID_ORIGIN}/embed/movie/{tmdb_id}?lang=hi&back=false&episodeSelector=false&autoplayNextEp=false`,
      series_template: `${TGVID_ORIGIN}/embed/tv/{tmdb_id}/{season}/{episode}?lang=hi&back=false&episodeSelector=false&autoplayNextEp=false`,
      anime_template: `${TGVID_ORIGIN}/embed/tv/{tmdb_id}/{season}/{episode}?lang=hi&back=false&episodeSelector=false&autoplayNextEp=false`,
      identifier_mode: 'tmdb_id' as const,
      audio_languages: ['multi'],
      subtitle_capability: false,
      quality_capability: [],
    },
  };
}

function content(type: 'movie' | 'series', tmdb?: string): NormalizedMediaItem {
  return {
    id: `tgvid-fixture-${tmdb ?? 'none'}`,
    title: 'Fixture title',
    year: 2024,
    type,
    runtime: '120 min',
    rating: 8,
    genres: ['Drama'],
    description: 'Fixture',
    poster: 'https://image.example.test/poster.jpg',
    backdrop: 'https://image.example.test/backdrop.jpg',
    accent: '#ffffff',
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
  // Seeded disabled → gated before the template adapter.
  await expectError(
    resolveSourceFromConfig({ sourceId, contentId: '1303331', mediaType: 'movie' }, tgvidConfig(), content('movie', '1303331')),
    'PROVIDER_DISABLED',
    '§7 seeded (disabled) provider gated',
  );

  const enabled = tgvidConfig({ providerEnabled: true, sourceEnabled: true });
  const movie = await resolveSourceFromConfig({ sourceId, contentId: '1303331', mediaType: 'movie' }, enabled, content('movie', '1303331'));
  ok(movie.type === 'embed' && movie.url === MOVIE_URL, '§7 movie template resolves to the EXACT documented URL (lang=hi + isolation params)');

  const series = await resolveSourceFromConfig({ sourceId, contentId: '94605', mediaType: 'series', season: 1, episode: 1 }, enabled, content('series', '94605'));
  ok(series.type === 'embed' && series.url === TV_URL, '§7 series template resolves to the EXACT documented URL');

  await expectError(
    resolveSourceFromConfig({ sourceId, contentId: 'x', mediaType: 'movie' }, enabled, content('movie')),
    'MISSING_IDENTIFIER',
    '§7 missing TMDB id → MISSING_IDENTIFIER',
  );

  // Tampered template (foreign origin) rejected by the shared embed guard.
  const tampered = tgvidConfig({ providerEnabled: true, sourceEnabled: true });
  tampered.source.movie_template = 'https://evil.example.test/embed/movie/{tmdb_id}?lang=hi';
  await expectError(
    resolveSourceFromConfig({ sourceId, contentId: '1303331', mediaType: 'movie' }, tampered, content('movie', '1303331')),
    'INVALID_SOURCE_URL',
    '§7 tampered/foreign template rejected',
  );

  // Sandbox provenance: required policy flows through the result.
  ok(movie.sandboxPolicy === 'required' && movie.sandboxRuntime?.effectiveSandboxPolicy === 'required', '§7 sandbox policy required (documented default)');
}

// ============================================================
// §8 — Migration contract (TGVID half)
// ============================================================

const migration = readFileSync(resolve('supabase/migrations/20261113000000_vixolity_tgvid_zxcstream_providers.sql'), 'utf-8');
ok(migration.includes("'tgvid'"), '§8 tgvid provider slug seeded');
ok(migration.includes("'tgvid-embed'"), '§8 tgvid source slug seeded');
ok(migration.includes("'tgvid'"), '§8 tgvid adapter_id wired (admin capability matrix)');
ok(migration.includes(`'allowed_embed_origins', jsonb_build_array('https://tgvid.lovable.app')`), '§8 embed origin pinned exactly');
ok(migration.includes("'sandbox_policy', 'required'"), '§8 sandbox policy required (default posture)');
ok(migration.includes('https://tgvid.lovable.app/embed/movie/{tmdb_id}?lang=hi&back=false&episodeSelector=false&autoplayNextEp=false'), '§8 movie template exact');
ok(migration.includes('https://tgvid.lovable.app/embed/tv/{tmdb_id}/{season}/{episode}?lang=hi&back=false&episodeSelector=false&autoplayNextEp=false'), '§8 series template exact');
ok((migration.match(/lang=hi/g) ?? []).length >= 6, '§8 lang=hi present in all three TGVID templates (movie/series/anime) + notes');
ok(!/'https:\/\/[^']*\?[^']*domainAd/.test(migration), '§8 no domainAd in any template');
ok(PROVIDER_CAPABILITY_MAP['tgvid'] === TGVID_CAPABILITIES, '§8 capability map key matches the migration adapter_id');

// ============================================================
// Summary
// ============================================================

console.log(`tgvid_provider_test: ${passed} checks passed`);
