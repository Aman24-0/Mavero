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
import { VidRiftPlayerAdapter } from '$lib/client/player/providers/vidrift-adapter';
import { VIDRIFT_CAPABILITIES, PROVIDER_CAPABILITY_MAP } from '$lib/client/player/capabilities';
import { nextEpisodeTarget } from '$lib/shared/player-state';
import type { PlayerEvent } from '$lib/client/player/events';

// VidRift provider integration tests (2026-11-05 production integration).
//
// Verified provider contract (https://vidrift.net/docs — official documentation):
//   Movie: https://embed.vidrift.net/embed/movie/{tmdb_id}
//   TV:    https://embed.vidrift.net/embed/tv/{tmdb_id}/{season}/{episode}
//   Anime: TV content under the hood — the TV shape with the show's TMDB id.
//   Approved params: brand=MAVERO, showTitle=1, watermark=1, hide=fullscreen
//   (ONLY fullscreen); poster/exit/uiScale/controlBg/font/muted/autoplay/
//   mobileSheets deliberately NOT set. brandLogo (deployed Mavero origin) and
//   brandColor (live --color-primary) injected dynamically client-side.
//   postMessage (origin https://embed.vidrift.net — strict): vidrift:progress
//   {currentTime,duration} every 5s, vidrift:paused/unpaused {currentTime},
//   vidrift:ended, vidrift:nextup-play (Up Next action), vidrift:episode
//   {season,episode} (player moved itself). Parent → player: vidrift:resume
//   {currentTime} (the DOCUMENTED resume — a postMessage seek, NOT a URL
//   param) and vidrift:nextup-info {next:{season,episode}|null}.
//   Sandbox: VidRift documents that a sandboxed iframe cannot play →
//   sandbox_policy 'unrestricted' (no sandbox attribute).

const providerId = '00000000-0000-4000-8000-0000000000vr1';
const VIDRIFT = 'https://embed.vidrift.net';
const APPROVED_PARAMS = 'brand=MAVERO&showTitle=1&watermark=1&hide=fullscreen';

// Mirrors migration 20261105000000_vidrift_provider.sql exactly.
const capabilities = {
  movie: true, series: true, anime: true,
  result_type: 'embed', supports_episode: true, supports_direct: false,
  supports_server_selection: false, automatic_server_fallback: false,
  supports_subtitles: false, supports_language_selection: false, supports_download: false,
  allow_experimental_playback: false,
  sandbox_policy: 'unrestricted',
  allowed_embed_origins: [VIDRIFT],
};
const config: TrustedResolutionConfig = {
  provider: { id: providerId, name: 'VidRift', status: 'active', enabled: true, integration_type: 'template', adapter_id: 'vidrift', capabilities },
  source: {
    id: 's1', provider_id: providerId, name: 'VidRift',
    status: 'active', enabled: true, visibility: 'public', integration_type: 'template',
    capabilities,
    movie_template: `${VIDRIFT}/embed/movie/{tmdb_id}?${APPROVED_PARAMS}`,
    series_template: `${VIDRIFT}/embed/tv/{tmdb_id}/{season}/{episode}?${APPROVED_PARAMS}`,
    anime_template: `${VIDRIFT}/embed/tv/{tmdb_id}/{season}/{episode}?${APPROVED_PARAMS}`,
    identifier_mode: 'tmdb_id',
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

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

// ============================================================
// §1 — URL construction (movie / TV / anime) + exact parameters
// ============================================================

// 1/2. Movie URL: exact route + approved parameter set.
const movie = await resolveSourceFromConfig(
  { sourceId: 's1', contentId: '299534', mediaType: 'movie' },
  config, content('movie', '299534'), { adapters },
);
ok(movie.type === 'embed', '§1 movie resolves as embed');
ok(movie.url === `${VIDRIFT}/embed/movie/299534?${APPROVED_PARAMS}`, `§1 movie URL exact: ${movie.url}`);

// 2. TV URL: season/episode in path, never 1/1 defaults.
const tv = await resolveSourceFromConfig(
  { sourceId: 's1', contentId: '1399', mediaType: 'series', season: 2, episode: 5 },
  config, content('series', '1399'), { adapters },
);
ok(tv.url === `${VIDRIFT}/embed/tv/1399/2/5?${APPROVED_PARAMS}`, `§2 TV URL exact: ${tv.url}`);

// 3. Anime URL: the TV shape with the show's TMDB id (official contract).
const anime = await resolveSourceFromConfig(
  { sourceId: 's1', contentId: '1429', mediaType: 'anime', season: 1, episode: 1 },
  config, { ...content('series', '1429'), type: 'anime' as 'series' }, { adapters },
);
ok(anime.url === `${VIDRIFT}/embed/tv/1429/1/1?${APPROVED_PARAMS}`, `§3 anime uses the TV route: ${anime.url}`);

// 4-16. Exact parameter generation: the approved set, nothing else.
const url = new URL(movie.url);
ok(url.searchParams.get('brand') === 'MAVERO', '§5 brand=MAVERO');
ok(url.searchParams.get('showTitle') === '1', '§10 showTitle=1');
ok(url.searchParams.get('watermark') === '1', '§9 watermark=1 (reuses brandLogo)');
ok(url.searchParams.get('hide') === 'fullscreen', '§12 hide=fullscreen ONLY');
ok(!url.searchParams.has('poster'), '§8 no custom poster (VidRift/TMDB default artwork)');
ok(!url.searchParams.has('exit'), '§11 exit NOT enabled (Mavero owns back navigation)');
ok(!url.searchParams.has('mobileSheets'), '§13 mobileSheets absent (OFF)');
ok(!url.searchParams.has('muted'), '§14 muted not overridden');
ok(!url.searchParams.has('autoplay'), '§14 autoplay not overridden');
ok(!url.searchParams.has('controlBg'), '§15 controlBg not overridden (default gradient)');
ok(!url.searchParams.has('font'), '§16 font not overridden (VidRift default)');
ok(!url.searchParams.has('uiScale'), 'uiScale not overridden (responsive default)');
ok(!url.searchParams.has('layout'), 'layout not overridden');
ok(!url.searchParams.has('title'), 'title param not set (player looks it up itself)');
ok(url.origin === VIDRIFT, `§17 exact iframe origin: ${url.origin}`);
// hide=fullscreen is a SINGLE control — no comma list, no other controls.
ok((url.searchParams.get('hide') ?? '').split(',').length === 1, '§12 hide contains exactly one control');

// Sandbox: the resolved source carries the unrestricted policy (no sandbox
// attribute is rendered for it — VidRift documents sandboxed iframes cannot play).
ok(movie.sandboxPolicy === 'unrestricted', 'sandbox policy unrestricted (no sandbox attribute)');
ok(movie.sandboxRuntime?.effectiveSandboxPolicy === 'unrestricted', 'effective sandbox runtime unrestricted');

// ============================================================
// §2 — Migration content assertions
// ============================================================

const migration = readFileSync(resolve('supabase/migrations/20261105000000_vidrift_provider.sql'), 'utf-8');
ok(migration.includes(`${VIDRIFT}/embed/movie/{tmdb_id}?${APPROVED_PARAMS}`), 'migration: movie template exact');
ok(migration.includes(`${VIDRIFT}/embed/tv/{tmdb_id}/{season}/{episode}?${APPROVED_PARAMS}`), 'migration: series template exact');
ok(migration.includes("'vidrift-embed'"), 'migration: single source slug');
ok((migration.match(/insert into public\.streaming_sources/g) ?? []).length === 1, 'migration: exactly ONE VidRift source row');
ok(migration.includes("'sandbox_policy', 'unrestricted'"), 'migration: sandbox_policy unrestricted (documented provider requirement)');
ok(migration.includes("jsonb_build_array('https://embed.vidrift.net')"), 'migration: canonical origin allowlisted');
ok(migration.includes("'vidrift'"), 'migration: adapter_id vidrift (capability matrix key)');
ok(migration.includes("'anime', true"), 'migration: anime supported (TV shape)');
ok(migration.includes("'tmdb_id'"), 'migration: tmdb_id identifier mode');
ok(migration.includes('290,'), 'migration: ordering 290');
// No forbidden mechanisms anywhere in the migration: no GitHub runtime
// dependency, no legacy-host template, no direct-media extraction. (The
// notes' negative statement "does not scrape, proxy, extract" is fine —
// only actual mechanisms are forbidden.)
ok(!migration.includes('github.com'), 'migration: no GitHub dependency (Mavero-origin static asset)');
ok(!migration.includes('vidrift.in'), 'migration: canonical .net origin only (no legacy-host template)');
ok(!/https?:\/\/(?!embed\.vidrift\.net|vidrift\.net)/.test(migration), 'migration: no external URLs beyond the canonical VidRift origin (+ its docs link)');

// ============================================================
// §3 — Adapter contract (window/document mocks)
// ============================================================

class MockMessageEvent {
  type: string; origin: string; data: unknown;
  constructor(type: string, init: { origin?: string; data?: unknown } = {}) {
    this.type = type; this.origin = init.origin ?? ''; this.data = init.data;
  }
}
const messageListeners = new Set<(event: { type: string; origin: string; data: unknown }) => void>();
let accentTokenValue = '#00ff9c'; // canonical Mavero --color-primary value
let mockOrigin = 'https://mavero.example.test';
const mockWindow = {
  location: { origin: mockOrigin },
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
function makeSource(url: string, mediaType: 'movie' | 'series' | 'anime' = 'movie'): PlayerSource {
  return { type: 'embed', url, providerId, sourceId: 's1', mediaType };
}

// Fake iframe: records postMessage sends with their target origin.
type SentMessage = { payload: Record<string, unknown>; targetOrigin: string };
function makeFakeIframe() {
  const sent: SentMessage[] = [];
  const listeners = new Map<string, Set<() => void>>();
  return {
    sent,
    contentWindow: {
      postMessage: (payload: Record<string, unknown>, targetOrigin: string) => { sent.push({ payload, targetOrigin }); },
    },
    addEventListener: (type: string, listener: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => { listeners.get(type)?.delete(listener); },
    fire: (type: string) => { for (const l of listeners.get(type) ?? []) l(); },
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

// --- Capabilities + registry ---

const adapter = new VidRiftPlayerAdapter();
ok(JSON.stringify(adapter.getCapabilities()) === JSON.stringify(VIDRIFT_CAPABILITIES), 'capabilities exact');
ok(PROVIDER_CAPABILITY_MAP['vidrift'] === VIDRIFT_CAPABILITIES, 'capability map entry registered');
ok(adapter.startAtParam() === null, '§22 resume is NOT a URL parameter (documented vidrift:resume postMessage)');

ok(adapter.canHandle(makeSource(`${VIDRIFT}/embed/movie/299534`)), 'canHandle canonical origin');
ok(!adapter.canHandle(makeSource('https://embed.vidrift.in/embed/movie/299534')), 'canHandle rejects the legacy .in host (canonical .net only)');
ok(!adapter.canHandle(makeSource('https://vidstuck.xyz/embed/movie/299534')), 'canHandle rejects other providers');
ok(!adapter.canHandle({ type: 'direct', url: 'https://example.test/v.mp4', providerId, sourceId: 's1', mediaType: 'movie' }), 'canHandle rejects direct sources');

{
  const registry = createDefaultAdapterRegistry();
  ok(registry.pickAdapter(makeSource(`${VIDRIFT}/embed/movie/299534`)) instanceof VidRiftPlayerAdapter, 'registry picks the VidRift adapter');
  // §31 regression: existing providers keep their adapters, VidRift inserted
  // BEFORE the generic fallback.
  const all = registry.list();
  ok(all[all.length - 1].constructor.name === 'EmbedPlayerAdapter', 'generic embed fallback still LAST');
  ok(all.filter((a) => a.constructor.name === 'VidRiftPlayerAdapter').length === 1, 'exactly one VidRift adapter registered');
}

// --- §20 progress message parsing ---

const events: PlayerEvent[] = [];
adapter.onEvent((e) => events.push(e));
adapter.load({ source: makeSource(`${VIDRIFT}/embed/movie/299534?${APPROVED_PARAMS}`), startPosition: 0 });

events.length = 0;
simulateMessage(VIDRIFT, { type: 'vidrift:progress', tmdbId: '299534', mediaType: 'movie', currentTime: 120, duration: 7200 });
ok(events.length === 1 && events[0].type === 'timeupdate', '§20 vidrift:progress → timeupdate');
ok(events[0].type === 'timeupdate' && events[0].currentTime === 120, 'progress currentTime mapped');
ok(events[0].type === 'timeupdate' && events[0].duration === 7200, 'progress duration mapped');

simulateMessage(VIDRIFT, { type: 'vidrift:paused', tmdbId: '299534', currentTime: 125 });
ok(events[events.length - 1].type === 'pause', 'vidrift:paused → pause');
simulateMessage(VIDRIFT, { type: 'vidrift:unpaused', tmdbId: '299534', currentTime: 125 });
ok(events[events.length - 1].type === 'play', 'vidrift:unpaused → play');
simulateMessage(VIDRIFT, { type: 'vidrift:ended', tmdbId: '299534', season: null, episode: null });
ok(events[events.length - 1].type === 'ended', 'vidrift:ended → ended');

// Informational/unused messages: acknowledged, never normalized.
for (const type of ['vidrift:ui-visible', 'vidrift:ui-hidden', 'vidrift:nextup', 'vidrift:exit', 'vidrift:mobile-panel']) {
  events.length = 0;
  simulateMessage(VIDRIFT, { type, tmdbId: '299534' });
  ok(events.length === 0, `${type} acknowledged, not normalized`);
}

// --- §19 invalid message rejection ---

for (const bad of [
  { type: 'vidrift:progress' },                                              // no currentTime
  { type: 'vidrift:progress', currentTime: '120' },                          // string number
  { type: 'vidrift:progress', currentTime: -5 },                             // negative
  { type: 'vidrift:progress', currentTime: NaN },                            // NaN
  { type: 'vidrift:progress', currentTime: Infinity },                       // Infinity
  { type: 'vidrift:episode' },                                               // no target
  { type: 'vidrift:episode', season: 0, episode: 2 },                        // season 0
  { type: 'vidrift:episode', season: 1.5, episode: 2 },                      // non-integer
  { type: 'vidrift:episode', season: 1, episode: -2 },                       // negative episode
  { type: 'somethingelse', currentTime: 5 },                                 // not a vidrift: type
  { type: 'vidrift:' },                                                      // bare prefix
  'not json',
  42,
  null,
  undefined,
  [],
]) {
  events.length = 0;
  simulateMessage(VIDRIFT, bad);
  ok(events.length === 0, `§19 invalid payload dropped: ${JSON.stringify(bad)}`);
}

// --- §18 postMessage origin validation (strict exact match) ---

for (const badOrigin of [
  'https://embed.vidrift.in',       // legacy documented host — NOT accepted (canonical .net only)
  'https://embed.vidrift.net.evil.com',
  'https://evil.example.com',
  'http://embed.vidrift.net',
  'https://embed.vidrift.net:443',  // serialized with an explicit port — not byte-identical
  '',
]) {
  events.length = 0;
  simulateMessage(badOrigin, { type: 'vidrift:progress', currentTime: 5, duration: 100 });
  ok(events.length === 0, `§18 message origin rejected: '${badOrigin}'`);
}

// --- §24 foreign-episode/foreign-title message rejection (leak defense) ---

const tvAdapter = new VidRiftPlayerAdapter();
const tvEvents: PlayerEvent[] = [];
tvAdapter.onEvent((e) => tvEvents.push(e));
tvAdapter.load({ source: makeSource(`${VIDRIFT}/embed/tv/1399/2/5?${APPROVED_PARAMS}`, 'series'), startPosition: 0 });

tvEvents.length = 0;
simulateMessage(VIDRIFT, { type: 'vidrift:progress', tmdbId: '1399', season: 2, episode: 5, currentTime: 100, duration: 3600 });
ok(tvEvents.length === 1, 'matching TV progress accepted');

tvEvents.length = 0;
simulateMessage(VIDRIFT, { type: 'vidrift:progress', tmdbId: '1399', season: 2, episode: 6, currentTime: 100, duration: 3600 });
ok(tvEvents.length === 0, '§24 foreign-episode progress dropped (no leak into the current record)');

tvEvents.length = 0;
simulateMessage(VIDRIFT, { type: 'vidrift:progress', tmdbId: '999', season: 2, episode: 5, currentTime: 100, duration: 3600 });
ok(tvEvents.length === 0, '§24 foreign-title progress dropped');

tvEvents.length = 0;
simulateMessage(VIDRIFT, { type: 'vidrift:progress', tmdbId: 1399, season: 2, episode: 5, currentTime: 7, duration: 3600 });
ok(tvEvents.length === 1, 'numeric tmdbId matches the string URL tag');

// vidrift:episode is exempt from the season/episode part (its fields are the
// TARGET episode) but still title-guarded.
tvEvents.length = 0;
simulateMessage(VIDRIFT, { type: 'vidrift:episode', tmdbId: '1399', season: 2, episode: 6 });
ok(tvEvents.length === 1 && tvEvents[0].type === 'next-episode', 'vidrift:episode (target fields) accepted');
ok(tvEvents[0].type === 'next-episode' && tvEvents[0].season === 2 && tvEvents[0].episode === 6, 'vidrift:episode target carried');
tvEvents.length = 0;
simulateMessage(VIDRIFT, { type: 'vidrift:episode', tmdbId: '999', season: 2, episode: 6 });
ok(tvEvents.length === 0, 'vidrift:episode with a foreign title dropped');

// --- §27 auto-next: nextup-play → ended + next-episode (Mavero-driven) ---

tvEvents.length = 0;
simulateMessage(VIDRIFT, { type: 'vidrift:nextup-play', tmdbId: '1399', mediaType: 'tv', season: 2, episode: 5 });
ok(tvEvents.length === 2, '§27 nextup-play emits exactly two events');
ok(tvEvents[0].type === 'ended', 'nextup-play first completes the progress pipeline (ended → writer.complete)');
ok(tvEvents[1].type === 'next-episode' && tvEvents[1].season === undefined && tvEvents[1].episode === undefined, 'nextup-play then signals navigation without a provider target');

// --- §22/§23 resume: the documented vidrift:resume postMessage ---

function findSent(fake: ReturnType<typeof makeFakeIframe>, type: string): SentMessage | undefined {
  return fake.sent.find((m) => (m.payload as { type?: string }).type === type);
}

// 22. Movie resume.
{
  const fake = makeFakeIframe();
  const a = new VidRiftPlayerAdapter();
  const evts: PlayerEvent[] = [];
  a.onEvent((e) => evts.push(e));
  a.load({ source: makeSource(`${VIDRIFT}/embed/movie/299534?${APPROVED_PARAMS}`), startPosition: 726.9 });
  a.setIframe(fake as unknown as HTMLIFrameElement);
  const resume = findSent(fake, 'vidrift:resume');
  ok(resume !== undefined, '§22 movie resume sent as vidrift:resume');
  ok(resume?.payload.currentTime === 726, 'resume currentTime is the floored startPosition');
  ok(resume?.targetOrigin === VIDRIFT, 'resume targets the EXACT documented origin');
  ok(fake.listenerCount('load') === 1, 'iframe load listener attached for re-delivery');
  fake.fire('load');
  ok((fake.sent.filter((m) => (m.payload as { type?: string }).type === 'vidrift:resume')).length === 2, 'resume re-delivered on iframe load (idempotent)');
  // No re-send once playback has reported a position at/after the resume
  // point. (The first player message also re-delivers once — it proves the
  // channel is live and runs BEFORE lastObservedTime updates; that send is
  // part of the idempotent delivery contract, after which playback
  // positions block every further send.)
  simulateMessage(VIDRIFT, { type: 'vidrift:progress', tmdbId: '299534', currentTime: 800, duration: 7200 });
  const resumeCountAfterProgress = fake.sent.filter((m) => (m.payload as { type?: string }).type === 'vidrift:resume').length;
  fake.fire('load');
  simulateMessage(VIDRIFT, { type: 'vidrift:progress', tmdbId: '299534', currentTime: 810, duration: 7200 });
  fake.fire('load');
  ok(fake.sent.filter((m) => (m.payload as { type?: string }).type === 'vidrift:resume').length === resumeCountAfterProgress, 'resume never re-sent after playback passed it');
  a.destroy();
  ok(fake.listenerCount('load') === 0, '§30 iframe load listener removed on destroy');
}

// 23. Episode resume + fresh start.
{
  const fake = makeFakeIframe();
  const a = new VidRiftPlayerAdapter();
  a.load({ source: makeSource(`${VIDRIFT}/embed/tv/1399/2/5?${APPROVED_PARAMS}`, 'series'), startPosition: 1200 });
  a.setIframe(fake as unknown as HTMLIFrameElement);
  const resume = findSent(fake, 'vidrift:resume');
  ok(resume?.payload.currentTime === 1200, '§23 episode resume sent (seconds)');
  a.destroy();
}
{
  const fake = makeFakeIframe();
  const a = new VidRiftPlayerAdapter();
  a.load({ source: makeSource(`${VIDRIFT}/embed/movie/299534?${APPROVED_PARAMS}`), startPosition: 0 });
  a.setIframe(fake as unknown as HTMLIFrameElement);
  fake.fire('load');
  ok(findSent(fake, 'vidrift:resume') === undefined, 'no resume message on a fresh start (startPosition 0)');
  a.destroy();
}

// First-contact re-delivery: the first player message proves the channel is
// live — resume + nextup-info are re-sent then.
{
  const fake = makeFakeIframe();
  const a = new VidRiftPlayerAdapter();
  a.onEvent(() => {});
  a.load({ source: makeSource(`${VIDRIFT}/embed/movie/299534?${APPROVED_PARAMS}`), startPosition: 500, nextEpisode: undefined });
  a.setIframe(fake as unknown as HTMLIFrameElement);
  fake.sent.length = 0; // drop the early best-effort sends
  simulateMessage(VIDRIFT, { type: 'vidrift:ui-hidden', tmdbId: '299534' });
  ok(findSent(fake, 'vidrift:resume') !== undefined, 'resume re-delivered on first player contact');
  a.destroy();
}

// --- §27 auto-next metadata: vidrift:nextup-info ---

{
  const fake = makeFakeIframe();
  const a = new VidRiftPlayerAdapter();
  a.onEvent(() => {});
  // Series mid-season: next = {season, episode}.
  a.load({ source: makeSource(`${VIDRIFT}/embed/tv/1399/2/5?${APPROVED_PARAMS}`, 'series'), startPosition: 0, nextEpisode: { season: 2, episode: 6 } });
  a.setIframe(fake as unknown as HTMLIFrameElement);
  const info = findSent(fake, 'vidrift:nextup-info');
  ok(info !== undefined, '§27 nextup-info sent');
  ok(JSON.stringify(info?.payload.next) === JSON.stringify({ season: 2, episode: 6 }), 'nextup-info carries Mavero\'s next episode');
  ok(info?.targetOrigin === VIDRIFT, 'nextup-info targets the exact origin');
  a.destroy();
}
{
  // §29 series finale: next = null (no fake next episode).
  const fake = makeFakeIframe();
  const a = new VidRiftPlayerAdapter();
  a.onEvent(() => {});
  a.load({ source: makeSource(`${VIDRIFT}/embed/tv/1399/8/6?${APPROVED_PARAMS}`, 'series'), startPosition: 0, nextEpisode: null });
  a.setIframe(fake as unknown as HTMLIFrameElement);
  const info = findSent(fake, 'vidrift:nextup-info');
  ok(info !== undefined && info.payload.next === null, '§29 finale sends next: null');
  a.destroy();
}
{
  // Movie: NO next-up metadata at all.
  const fake = makeFakeIframe();
  const a = new VidRiftPlayerAdapter();
  a.onEvent(() => {});
  a.load({ source: makeSource(`${VIDRIFT}/embed/movie/299534?${APPROVED_PARAMS}`), startPosition: 0, nextEpisode: undefined });
  a.setIframe(fake as unknown as HTMLIFrameElement);
  fake.fire('load');
  simulateMessage(VIDRIFT, { type: 'vidrift:ui-hidden', tmdbId: '299534' });
  ok(findSent(fake, 'vidrift:nextup-info') === undefined, 'movie playback never receives TV next-up metadata');
  a.destroy();
}

// --- §6/§7 dynamic brand: logo + accent ---

// (a) brandLogo = the deployed Mavero origin serving Mavero's own favicon.
// (b) brandColor = the LIVE theme token, 6-digit hex without '#'.
{
  const finalized = adapter.finalizeEmbedUrl(`${VIDRIFT}/embed/movie/299534?${APPROVED_PARAMS}`)!;
  const u = new URL(finalized);
  ok(u.searchParams.get('brandLogo') === 'https://mavero.example.test/icons/favicon-32.png', `§6 brandLogo from the deployed Mavero origin: ${u.searchParams.get('brandLogo')}`);
  ok(u.searchParams.get('brandColor') === '00ff9c', '§7 brandColor from the live --color-primary token (no #)');
  ok(u.searchParams.get('brand') === 'MAVERO', 'approved static params preserved');
  ok(u.searchParams.get('watermark') === '1', 'watermark preserved (reuses the dynamic brandLogo)');
  ok(!u.searchParams.has('poster'), 'no poster injected');
}
// 3-digit token expanded without changing the visual value.
accentTokenValue = '#0f9';
ok(new URL(adapter.finalizeEmbedUrl(`${VIDRIFT}/embed/movie/1`)!).searchParams.get('brandColor') === '00ff99', '3-digit accent expanded to 6 digits');
// 8-digit token: alpha dropped.
accentTokenValue = '00ff9ccc';
ok(new URL(adapter.finalizeEmbedUrl(`${VIDRIFT}/embed/movie/1`)!).searchParams.get('brandColor') === '00ff9c', '8-digit accent: alpha dropped');
// No '#' ever.
accentTokenValue = '#00ff9c';
ok(!new URL(adapter.finalizeEmbedUrl(`${VIDRIFT}/embed/movie/1`)!).searchParams.get('brandColor')!.includes('#'), 'brandColor never contains #');
// Token missing/invalid → brandColor omitted, other params intact.
accentTokenValue = 'not-a-color';
{
  const finalized = adapter.finalizeEmbedUrl(`${VIDRIFT}/embed/movie/299534?${APPROVED_PARAMS}`)!;
  ok(!new URL(finalized).searchParams.has('brandColor'), 'invalid token → brandColor omitted');
  ok(new URL(finalized).searchParams.get('brandLogo') !== null, 'brandLogo still injected');
}
accentTokenValue = '';
// No token AND no logo (non-https origin) → URL unchanged.
mockWindow.location = { origin: 'http://dev.local' };
ok(adapter.finalizeEmbedUrl(`${VIDRIFT}/embed/movie/299534`) === null, 'no token + no logo → URL unchanged');
mockWindow.location = { origin: 'https://mavero.example.test' };
accentTokenValue = '#00ff9c';
// Non-https origin (http dev) → logo omitted (VidRift requires https).
mockWindow.location = { origin: 'http://localhost:5173' };
ok(!new URL(adapter.finalizeEmbedUrl(`${VIDRIFT}/embed/movie/299534`)!).searchParams.has('brandLogo'), 'http origin → brandLogo omitted (https required)');
ok(new URL(adapter.finalizeEmbedUrl(`${VIDRIFT}/embed/movie/299534`)!).searchParams.has('brandColor'), 'brandColor still injected on http dev origins');
mockWindow.location = { origin: 'https://mavero.example.test' };
// Existing values are replaced, never duplicated.
{
  const finalized = adapter.finalizeEmbedUrl(`${VIDRIFT}/embed/movie/299534?brandColor=FF0000&brandLogo=https://old.example.test/x.png`)!;
  const u = new URL(finalized);
  ok(u.searchParams.get('brandColor') === '00ff9c', 'existing brandColor replaced');
  ok(u.searchParams.get('brandLogo') === 'https://mavero.example.test/icons/favicon-32.png', 'existing brandLogo replaced');
}
// Invalid URL input → null, never throws.
ok(adapter.finalizeEmbedUrl('not a url') === null, 'invalid URL input → null');
// Non-browser environment → null.
const realWindow = (globalThis as unknown as { window: unknown }).window;
delete (globalThis as unknown as { window?: unknown }).window;
ok(adapter.finalizeEmbedUrl(`${VIDRIFT}/embed/movie/299534`) === null, '§7 non-browser → URL unchanged (null)');
(globalThis as unknown as { window: unknown }).window = realWindow;

// --- §34 no stale listeners: destroy stops everything ---

adapter.destroy();
events.length = 0;
simulateMessage(VIDRIFT, { type: 'vidrift:progress', tmdbId: '299534', currentTime: 5, duration: 100 });
ok(events.length === 0, '§34 no events after destroy');
tvAdapter.destroy();
tvEvents.length = 0;
simulateMessage(VIDRIFT, { type: 'vidrift:progress', tmdbId: '1399', season: 2, episode: 5, currentTime: 5 });
ok(tvEvents.length === 0, '§34 TV adapter: no events after destroy');

// --- §32/§33 retry + adapter state reset (no duplicate sends) ---

{
  const fake = makeFakeIframe();
  const a = new VidRiftPlayerAdapter();
  a.onEvent(() => {});
  a.load({ source: makeSource(`${VIDRIFT}/embed/tv/1399/1/1?${APPROVED_PARAMS}`, 'series'), startPosition: 300, nextEpisode: { season: 1, episode: 2 } });
  a.setIframe(fake as unknown as HTMLIFrameElement);
  a.destroy(); // switching away / retry destroys the session
  const sendsBeforeRetry = fake.sent.length;
  // Retry: fresh load on the SAME adapter instance (registry reuse).
  a.load({ source: makeSource(`${VIDRIFT}/embed/tv/1399/1/1?${APPROVED_PARAMS}`, 'series'), startPosition: 300, nextEpisode: { season: 1, episode: 2 } });
  fake.fire('load'); // stale listener from the previous session must NOT re-fire
  simulateMessage(VIDRIFT, { type: 'vidrift:progress', tmdbId: '1399', season: 1, episode: 1, currentTime: 305, duration: 3600 });
  ok(fake.sent.length === sendsBeforeRetry, '§32 retry: no duplicate sends from the destroyed session');
  const resumes = fake.sent.filter((m) => (m.payload as { type?: string }).type === 'vidrift:resume');
  ok(resumes.length >= 1 && resumes.every((m) => m.payload.currentTime === 300), 'retry session delivers resume to the fresh context');
  a.destroy();
}

// ============================================================
// §21/§25/§26 — end-to-end through the PlaybackManager: progress events
// reach external subscribers (the watch route's existing ProgressWriter
// entry point) — the canonical persistence path, no second system.
// ============================================================

function makeFetch(source: PlayerSource): typeof fetch {
  return async () => new Response(JSON.stringify({ ok: true, source }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }) as unknown as Response;
}

{
  const manager = new PlaybackManager({
    fetcher: makeFetch(makeSource(`${VIDRIFT}/embed/movie/299534?${APPROVED_PARAMS}`)),
    registry: createDefaultAdapterRegistry(),
  });
  const received: PlayerEvent[] = [];
  manager.onEvent((event) => received.push(event));
  await manager.loadSource({ sourceId: 's', contentId: '299534', mediaType: 'movie' }, 0, true);
  const source = manager.getSource()!;
  ok(source.url!.startsWith(`${VIDRIFT}/embed/movie/299534?${APPROVED_PARAMS}`), 'manager: approved params preserved');
  ok(new URL(source.url!).searchParams.get('brandLogo') === 'https://mavero.example.test/icons/favicon-32.png', 'manager: dynamic brandLogo injected');
  ok(new URL(source.url!).searchParams.get('brandColor') === '00ff9c', 'manager: dynamic brandColor injected');
  ok(!source.url!.includes('resume'), '§22 resume NOT in the URL (documented postMessage mechanism instead)');
  // Simulate the provider stream through the REAL window listener the
  // registry adapter registered.
  simulateMessage(VIDRIFT, { type: 'vidrift:progress', tmdbId: '299534', mediaType: 'movie', currentTime: 250, duration: 7200 });
  ok(received.some((e) => e.type === 'timeupdate' && e.currentTime === 250), '§21 vidrift:progress reaches the external subscriber (ProgressWriter entry)');
  const stateAfter = manager.getState();
  ok(stateAfter.currentTime === 250 && stateAfter.duration === 7200, 'manager tracks provider currentTime/duration');
  // nextup-play flows through: ended (writer.complete) + next-episode (navigation).
  received.length = 0;
  simulateMessage(VIDRIFT, { type: 'vidrift:nextup-play', tmdbId: '299534', mediaType: 'movie', season: null, episode: null });
  ok(received.some((e) => e.type === 'ended'), '§27 nextup-play: ended reaches subscribers (completion pipeline)');
  ok(received.some((e) => e.type === 'next-episode'), '§27 nextup-play: next-episode reaches subscribers (navigation signal)');
  ok(manager.getState().state === 'completed', 'manager completes on nextup-play');
  // §31 provider switching destroys the session adapter — late messages die.
  manager.dispose();
  received.length = 0;
  simulateMessage(VIDRIFT, { type: 'vidrift:progress', tmdbId: '299534', currentTime: 999 });
  ok(received.length === 0, '§31 after dispose, no stale adapter events');
}

// ============================================================
// §28 — nextEpisodeTarget: season transition + finale + unknown
// ============================================================

const seasonOne = [1, 2, 3].map((n) => ({ id: `e${n}`, number: n, season: 1, title: `S1E${n}` }));
ok(JSON.stringify(nextEpisodeTarget(seasonOne, { season: 1, episode: 1 }, 2)) === JSON.stringify({ season: 1, episode: 2, title: 'S1E2' }), '§28 mid-season next episode');
ok(JSON.stringify(nextEpisodeTarget(seasonOne, { season: 1, episode: 3 }, 2)) === JSON.stringify({ season: 2, episode: 1 }), '§28 season finale → next season E1 (season transition)');
ok(nextEpisodeTarget(seasonOne, { season: 1, episode: 3 }, 1) === null, '§29 series finale → null (no fake next)');
ok(nextEpisodeTarget(seasonOne, { season: 1, episode: 3 }) === null, 'unknown season count → conservative null at a season end');
ok(nextEpisodeTarget(seasonOne, null, 2) === undefined, 'no episode context → undefined (no takeover)');
ok(nextEpisodeTarget([], { season: 2, episode: 1 }, 2) === undefined, 'empty episode list → undefined (provider self-drives)');
ok(nextEpisodeTarget(seasonOne, { season: 2, episode: 1 }, 2) === undefined, 'current episode not in the loaded list → undefined');

// ============================================================
// Watch route wiring (source-level, per the established convention)
// ============================================================

const watchRoute = readFileSync(resolve('src/routes/watch/[type]/[id]/+page.svelte'), 'utf-8');
ok(watchRoute.includes('nextEpisodeTarget('), 'watch route computes the next-episode context');
ok(watchRoute.includes('request.nextEpisode = nextEpisodeForCurrent'), 'watch route forwards the context to loadSource');
ok(watchRoute.includes("event.type === 'next-episode'"), 'watch route handles the next-episode event');
ok(/next-episode[\s\S]{0,2200}handleEpisodeChange\(target\)/.test(watchRoute), 'next-episode navigates through the EXISTING handleEpisodeChange');
ok(watchRoute.includes("contentType === 'movie'\n    ? undefined"), 'movies never receive next-up metadata');
// The resolver POST body must NOT include the client-only field.
ok(!/body\.nextEpisode/.test(readFileSync(resolve('src/lib/client/player/PlaybackManager.ts'), 'utf-8')), 'nextEpisode never sent to the resolver endpoint');
// Provider-directed targets are validated before navigating.
ok(watchRoute.includes('candidate.season === event.season && candidate.number === event.episode'), 'provider-directed targets validated against Mavero episode data');

// PlayerViewport regression: the iframe stays referrerpolicy-default for all
// providers — no per-provider referrer change was introduced.
const viewport = readFileSync(resolve('src/lib/components/player/PlayerViewport.svelte'), 'utf-8');
ok(viewport.includes('allowfullscreen'), 'iframe allowfullscreen preserved (Mavero fullscreen)');
ok(!viewport.includes('vidrift'), 'PlayerViewport unchanged by the VidRift integration (no provider-specific viewport logic)');

console.log(`VidRift provider integration tests passed: ${passed} checks — exact URLs (movie/TV/anime TV-shape) + approved parameter set (brand=MAVERO, showTitle=1, watermark=1, hide=fullscreen ONLY; no poster/exit/uiScale/controlBg/font/muted/autoplay/mobileSheets), unrestricted sandbox (documented requirement), dynamic brandLogo (deployed Mavero origin) + brandColor (live --color-primary, no hardcoding), documented vidrift:resume postMessage (never a URL param) with idempotent re-delivery, vidrift:nextup-info with Mavero's authoritative next (null on finale, none for movies), progress/paused/unpaused/ended → canonical pipeline, nextup-play → ended + navigation through the existing architecture, strict origin validation + invalid/foreign-message rejection, episode-leak defense, teardown/retry/provider-switch safety, registry + regression assertions.`);
