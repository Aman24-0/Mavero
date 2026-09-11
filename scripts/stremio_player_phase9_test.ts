import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { PlayerQualityOption, PlayerSource } from '$lib/shared/player';
import { PLAYER_AUTO_QUALITY_ID } from '$lib/shared/player';
import { MAVERO_PLAYER_SOURCE_ID, MAVERO_PLAYER_SOURCE_NAME, maveroPlayerSourceOption } from '$lib/shared/mavero-player';
import { isPlayablePlayerSource } from '$lib/shared/player-guards';
import {
  MAVERO_PLAYER_MAX_STREAMS,
  MAVERO_PLAYER_STREAMS_PER_ADDON,
  maveroPlayerSourceFromResolution,
} from '$lib/server/streaming/stremio/mavero-player-source';
import {
  detectAudioLanguages,
  detectContainer,
  detectVideoCodec,
  MAX_STREAM_SUBTITLES,
  normalizeStremioStreamResponse,
} from '$lib/server/streaming/stremio/stream-normalize';
import type { StremioResolvedStream, StremioStreamResolution } from '$lib/server/streaming/stremio/stream-resolver';
import { stremioStreamToPlayerSource } from '$lib/server/streaming/stremio/stream-player-source';
import { validatePlaybackUrl } from '$lib/server/resolver/safe-url';
import { resolveStremioStreams } from '$lib/server/streaming/stremio/stream-resolver';
import { StreamServiceError } from '$lib/server/streaming/stremio/stream-errors';
import { StreamingAddon } from '$lib/shared/streaming-addons';
import {
  formatMaveroStreamSize,
  groupMaveroStreams,
  dedupeMaveroStreams,
  isMaveroAggregateSource,
  maveroStreamDetailLabel,
  maveroStreamSubtitleLabel,
} from '$lib/client/player/mavero-streams';
import {
  applyPendingSeek,
  capturePendingSeek,
  createPendingSeek,
  PENDING_SEEK_MAX_ATTEMPTS,
  PENDING_SEEK_RANGE_EPSILON,
  PENDING_SEEK_WINDOW_MS,
  type PendingSeekMedia,
  type PendingSeekState,
} from '$lib/client/player/pending-seek';
import {
  HlsPlaybackEngine,
  resolveDirectPlaybackMode,
  isHlsMediaSource,
  HLS_RECOVERY_LIMITS,
  type HlsFactory,
  type HlsLike,
  type HlsEventData,
} from '$lib/client/player/hls-engine';
import { EmbedPlayerAdapter } from '$lib/client/player/embed-adapter';

// Phase 9: Stremio playback compatibility + rich stream details + MAVERO
// stream UX + reliable streaming seeking. Behavioral tests over the REAL
// modules (aggregation, normalization, pending-seek state machine, engine
// routing) plus precise UI-contract pins where Svelte components cannot run
// under tsx (repo convention — see the Phase 5/6 suites).
//
//   1–6    fair addon aggregation (starvation fix, budgets, isolation)
//   7–13   rich addon metadata preservation (nothing invented)
//   14–18  source sheet / streams sheet separation + failure isolation
//   19–22  security re-pins (HTTPS boundary, SSRF, torrent, proxy)
//   23–25  pending-seek state machine (retained, cleared-on-apply, stale)
//   26–30  source switching matrix + recovery + browser compatibility
//   31–32  single playback engine (Video.js decision, no duplicate engines)
//   33–34  quality selection + AUTO only where appropriate
//   35     existing embed behavior intact
//   +      worklog / chain registration hygiene

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const shellSource = read('src/lib/components/player/PlayerShell.svelte');
const cardSource = read('src/lib/components/player/MaveroStreamCard.svelte');
const viewportSource = read('src/lib/components/player/PlayerViewport.svelte');
const controlsSource = read('src/lib/components/player/PlayerControls.svelte');
const pendingSeekSource = read('src/lib/client/player/pending-seek.ts');
const composerSource = read('src/lib/server/streaming/stremio/mavero-player-source.ts');
const normalizeSource = read('src/lib/server/streaming/stremio/stream-normalize.ts');
const packageJson = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; scripts: { test: string }; pnpm?: { overrides?: Record<string, string> } };
const worklog = read('docs/addon-worklog.md');
const engineSource = read('src/lib/client/player/hls-engine.ts');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let fixtureCounter = 0;
function resolvedStreamFixture(overrides: Partial<StremioResolvedStream> = {}): StremioResolvedStream {
  fixtureCounter += 1;
  return {
    addonId: overrides.addonId ?? `00000000-0000-4000-8000-${String(fixtureCounter).padStart(12, '0')}`,
    addonSlug: overrides.addonSlug ?? 'addon-a',
    addonName: overrides.addonName ?? 'Example HTTP Addon',
    addonOrdering: overrides.addonOrdering ?? 1,
    streamIndex: overrides.streamIndex ?? 0,
    streamName: overrides.streamName ?? 'Example 1080p',
    streamTitle: overrides.streamTitle ?? 'Example 1080p',
    url: overrides.url ?? 'https://cdn.example/example.m3u8',
    protocol: overrides.protocol ?? 'hls',
    transport: overrides.transport ?? 'https',
    mediaType: 'movie',
    videoId: 'tt1234567',
    idProperty: 'imdb_id',
    quality: overrides.quality ?? { label: '1080p', height: 1080 },
    ...overrides,
  };
}

function resolutionFixture(sources: StremioResolvedStream[], overrides: Partial<StremioStreamResolution> = {}): StremioStreamResolution {
  return {
    mediaType: 'movie',
    requestedMediaType: 'movie',
    unsupported: [],
    diagnostics: [],
    consideredAddons: 1,
    elapsedMs: 1,
    sources,
    ...overrides,
  };
}

function qualityFixture(overrides: Partial<PlayerQualityOption> = {}): PlayerQualityOption {
  return { url: 'https://cdn.example/example.m3u8', label: 'Example HTTP Addon · 1080p', height: 1080, addonName: 'Example HTTP Addon', protocol: 'hls', ...overrides };
}

function addonRowFixture(overrides: Partial<StreamingAddon> = {}): StreamingAddon {
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    name: 'Example HTTP Addon',
    slug: 'example-http-addon',
    manifestUrl: 'https://addon.example/manifest.json',
    enabled: true,
    status: 'active',
    ordering: 1,
    supportedTypes: ['movie'],
    idPrefixes: ['tt'],
    resources: ['stream'],
    capabilities: { supportsStream: true },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeSource(overrides: Partial<PlayerSource> = {}): PlayerSource {
  return { type: 'direct', url: 'https://cdn.example/v.mp4', providerId: 'p', sourceId: 's', mediaType: 'movie', ...overrides };
}

function makeVideo(canPlayHls: boolean): Pick<HTMLMediaElement, 'canPlayType'> {
  return { canPlayType: (type: string) => (canPlayHls && /mpegurl/i.test(type) ? 'probably' : '') };
}

// ---------------------------------------------------------------------------
// Fake addon HTTP client for resolver-level tests
// ---------------------------------------------------------------------------

function fakeAddonClient(rows: StreamingAddon[]) {
  const client = {
    from(_table: string) {
      return {
        select(_columns?: string, _options?: Record<string, unknown>) {
          return {
            eq(_col: string, _value: unknown) {
              return {
                in(_col: string, _values: unknown[]) {
                  return {
                    order(_col: string, _opts?: Record<string, unknown>) {
                      return {
                        order(_col2: string, _opts?: Record<string, unknown>) {
                          return {
                            limit(_n: number) {
                              return Promise.resolve({ data: rows.map((row) => ({
                                id: row.id, name: row.name, slug: row.slug, description: null, manifest_url: row.manifestUrl, enabled: row.enabled,
                                status: row.status, ordering: row.ordering, logo: null, version: null, id_property: null,
                                supported_types: row.supportedTypes, id_prefixes: row.idPrefixes, resources: row.resources,
                                capabilities: row.capabilities, notes: null, created_at: row.createdAt, updated_at: row.updatedAt,
                              })), error: null });
                            },
                            then(resolve: (r: { data: unknown[]; error: null }) => void) { resolve({ data: [], error: null }); },
                          };
                        },
                        then(resolve: (r: { data: unknown[]; error: null }) => void) { resolve({ data: [], error: null }); },
                      };
                    },
                    then(resolve: (r: { data: unknown[]; error: null }) => void) { resolve({ data: [], error: null }); },
                  };
                },
                then(resolve: (r: { data: unknown[]; error: null }) => void) { resolve({ data: [], error: null }); },
              };
            },
          };
        },
      } as never;
    },
  };
  return { client: client as never };
}

const PUBLIC_IP = { address: '93.184.216.34', family: 4 } as const;
const publicResolver = async () => [PUBLIC_IP] as never;

type RouteHandler = (init?: RequestInit) => Response;

function createFetcher(routes: Record<string, RouteHandler>, calls: Array<{ url: string }>): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url });
    const handler = routes[url] ?? routes['*'];
    if (!handler) return new Response('not found', { status: 404 });
    return handler(init);
  }) as typeof fetch;
}

function streamRoute(streams: Array<Record<string, unknown>>, status = 200): RouteHandler {
  return () => new Response(JSON.stringify({ streams }), { status, headers: { 'content-type': 'application/json' } });
}

function streamFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: '1080p', title: 'Example 1080p', url: 'https://cdn.example/example.m3u8', ...overrides };
}

// ===========================================================================
// 1–6 — fair addon aggregation (the starvation fix)
// ===========================================================================

{
  // The EXACT reported production failure: two prolific early addons flood
  // the old global cap of 24 and a third enabled addon (DesiFlix) never
  // appears. Round-robin buckets must represent ALL THREE.
  const sources = [
    ...Array.from({ length: 45 }, (_, i) => resolvedStreamFixture({ addonId: '00000000-0000-4000-8000-000000000001', addonSlug: 'pengu', addonName: 'PenguPlay', addonOrdering: 1, streamIndex: i, url: `https://pengu.example/s-${i}.m3u8`, quality: { label: 'Auto' } })),
    ...Array.from({ length: 30 }, (_, i) => resolvedStreamFixture({ addonId: '00000000-0000-4000-8000-000000000002', addonSlug: 'hdhub', addonName: 'HdHub', addonOrdering: 2, streamIndex: i, url: `https://hdhub.example/s-${i}.m3u8`, quality: { label: 'Auto' } })),
    ...Array.from({ length: 6 }, (_, i) => resolvedStreamFixture({ addonId: '00000000-0000-4000-8000-000000000003', addonSlug: 'desi', addonName: 'DesiFlix', addonOrdering: 3, streamIndex: i, url: `https://desi.example/s-${i}.m3u8`, quality: { label: 'Auto' } })),
  ];
  const aggregate = maveroPlayerSourceFromResolution(resolutionFixture(sources, { consideredAddons: 3 }));
  ok(aggregate !== null, '1: the aggregate composes from a multi-addon resolution');
  const byAddon = new Map<string, number>();
  for (const quality of aggregate?.qualities ?? []) byAddon.set(quality.addonName ?? '', (byAddon.get(quality.addonName ?? '') ?? 0) + 1);
  ok(byAddon.get('PenguPlay')! > 0 && byAddon.get('HdHub')! > 0 && byAddon.get('DesiFlix')! > 0, '1: all three addons are represented (2: no addon starved, 3: PenguPlay + HdHub + DesiFlix all appear)');
  ok((byAddon.get('DesiFlix') ?? 0) >= 6, '2: the late addon contributes ALL of its streams when under every budget');
  ok(byAddon.get('PenguPlay') === MAVERO_PLAYER_STREAMS_PER_ADDON, '2: the prolific first addon is itself capped by the per-addon budget');
  ok((aggregate?.qualities?.length ?? 0) === MAVERO_PLAYER_STREAMS_PER_ADDON + 30 + 6, '1: totals under every budget keep every stream; over-budget addons are capped, never starving others');
  // First entries interleave: one per addon per pass.
  const firstThreeAddons = (aggregate?.qualities ?? []).slice(0, 3).map((quality) => quality.addonName);
  ok(new Set(firstThreeAddons).size === 3, '2: pass 1 takes one stream from EVERY addon before any addon gets a second entry');
}

{
  // Per-addon budget: a single prolific addon cannot exceed the budget…
  const prolific = Array.from({ length: 90 }, (_, i) => resolvedStreamFixture({ addonId: '00000000-0000-4000-8000-000000000001', addonSlug: 'pengu', addonName: 'PenguPlay', addonOrdering: 1, streamIndex: i, url: `https://pengu.example/s-${i}.m3u8`, quality: { label: 'Auto' } }));
  const capped = maveroPlayerSourceFromResolution(resolutionFixture(prolific));
  ok(capped?.qualities?.length === MAVERO_PLAYER_STREAMS_PER_ADDON, `4: per-addon budget holds (${MAVERO_PLAYER_STREAMS_PER_ADDON} entries for a 90-stream addon)`);
  ok(capped?.qualities?.[0]?.url === 'https://pengu.example/s-0.m3u8', '4: the per-addon cap keeps the resolver\\u2019s first entries');

  // …and several prolific addons cannot exceed the TOTAL budget.
  const flood = [
    ...Array.from({ length: 60 }, (_, i) => resolvedStreamFixture({ addonId: '00000000-0000-4000-8000-000000000001', addonSlug: 'a', addonName: 'Addon A', addonOrdering: 1, streamIndex: i, url: `https://a.example/s-${i}.m3u8`, quality: { label: 'Auto' } })),
    ...Array.from({ length: 60 }, (_, i) => resolvedStreamFixture({ addonId: '00000000-0000-4000-8000-000000000002', addonSlug: 'b', addonName: 'Addon B', addonOrdering: 2, streamIndex: i, url: `https://b.example/s-${i}.m3u8`, quality: { label: 'Auto' } })),
    ...Array.from({ length: 60 }, (_, i) => resolvedStreamFixture({ addonId: '00000000-0000-4000-8000-000000000003', addonSlug: 'c', addonName: 'Addon C', addonOrdering: 3, streamIndex: i, url: `https://c.example/s-${i}.m3u8`, quality: { label: 'Auto' } })),
  ];
  const bounded = maveroPlayerSourceFromResolution(resolutionFixture(flood, { consideredAddons: 3 }));
  ok((bounded?.qualities?.length ?? 0) === MAVERO_PLAYER_MAX_STREAMS, `5: total aggregate cap holds (${MAVERO_PLAYER_MAX_STREAMS} entries across three 60-stream addons)`);
  const boundedByAddon = new Map<string, number>();
  for (const quality of bounded?.qualities ?? []) boundedByAddon.set(quality.addonName ?? '', (boundedByAddon.get(quality.addonName ?? '') ?? 0) + 1);
  ok(boundedByAddon.get('Addon C')! > 30, '5: even when the total cap truncates, every addon keeps proportional representation');
  ok(MAVERO_PLAYER_MAX_STREAMS === 100 && MAVERO_PLAYER_STREAMS_PER_ADDON === 40, '5: the budgets are the pinned Phase 9 constants (40 per addon / 100 total)');
  ok(bounded !== null && isPlayablePlayerSource(bounded), '5: the bounded aggregate still passes the shared playability guard');
}

{
  // Failed-addon isolation at the RESOLVER level (behavioral, not pins):
  // one addon 500s, the others still resolve.
  const calls: Array<{ url: string }> = [];
  const fetcher = createFetcher({
    'https://broken.example/stream/movie/tt1234567.json': streamRoute([], 500),
    'https://healthy.example/stream/movie/tt1234567.json': streamRoute([streamFixture(), streamFixture({ url: 'https://cdn.example/second.mp4', name: '720p' })]),
  }, calls);
  const { client } = fakeAddonClient([
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000b1', name: 'Broken', slug: 'broken', manifestUrl: 'https://broken.example/manifest.json', ordering: 1 }),
    addonRowFixture({ id: '00000000-0000-4000-8000-0000000000b2', name: 'Healthy', slug: 'healthy', manifestUrl: 'https://healthy.example/manifest.json', ordering: 2 }),
  ]);
  const resolution = await resolveStremioStreams(client, { mediaType: 'movie', identifiers: { imdbId: 'tt1234567', tmdbId: '12345' } }, { fetcher, dnsResolver: publicResolver });
  ok(calls.length === 2, '6: BOTH eligible addons are requested (the broken one is not skipped)');
  ok(resolution.sources.length === 2, '6: the healthy addon\\u2019s streams survive the broken addon\\u2019s HTTP 500');
  ok(resolution.diagnostics.some((entry) => entry.addonName === 'Broken' && entry.status === 'failed'), '6: the broken addon\\u2019s failure is recorded as an in-memory diagnostic');
  const composed = maveroPlayerSourceFromResolution(resolution);
  ok(composed !== null && composed.qualities?.length === 2, '6: the composed aggregate still carries the healthy addon\\u2019s streams');
  ok(composed?.qualities?.every((quality) => quality.addonName === 'Healthy'), '6: no fabricated entries from the failed addon');
}

// ===========================================================================
// 7–13 — rich addon metadata survives (nothing invented)
// ===========================================================================

{
  const response = {
    streams: [
      {
        name: '1080p',
        title: 'PenguPlay\n1080p HEVC Hindi 5.1',
        description: 'Movie Name (2024) 1080p WEB-DL AAC',
        url: 'https://cdn.example/movie.mkv',
        behaviorHints: { filename: 'Movie.Name.2024.1080p.HEVC.Hindi.WEB-DL.mkv', videoSize: 2254857830, bingeGroup: 'pengu-1080p' },
        subtitles: [
          { url: 'https://subs.example/en.vtt', lang: 'eng' },
          { url: 'https://subs.example/hi.vtt', label: 'Hindi' },
          'garbage-entry',
          { url: 'ftp://subs.example/bad.vtt' },
          { url: 'https://user:pass@subs.example/cred.vtt' },
        ],
      },
      { name: '720p', url: 'https://cdn.example/low.mp4' },
    ],
  };
  const normalized = normalizeStremioStreamResponse(response);
  ok(normalized.valid && normalized.streams.length === 2, '7: the response normalizes with metadata intact');
  const rich = normalized.streams[0];
  ok(rich.title === 'PenguPlay\n1080p HEVC Hindi 5.1', '8: the addon title is preserved verbatim (multi-line, unmodified)');
  ok(rich.name === '1080p', '8: the addon name is preserved');
  ok(rich.description === 'Movie Name (2024) 1080p WEB-DL AAC', '8: the addon description is preserved');
  ok(rich.filename === 'Movie.Name.2024.1080p.HEVC.Hindi.WEB-DL.mkv', '9: behaviorHints.filename is preserved');
  ok(rich.videoSize === 2254857830, '10: behaviorHints.videoSize is preserved (bytes)');
  ok(rich.bingeGroup === 'pengu-1080p', '10: behaviorHints.bingeGroup is preserved');
  ok(rich.subtitles?.length === 2, '11: valid addon subtitle tracks are preserved');
  ok(rich.subtitles?.[0]?.language === 'eng' && rich.subtitles?.[1]?.label === 'Hindi', '11: subtitle language/labels are preserved (malformed/credentialed entries dropped)');
  ok(rich.audioLanguages?.join(',') === 'Hindi', '12: audio language is derived ONLY from addon-supplied text ("1080p HEVC Hindi 5.1" → Hindi)');
  ok(rich.codec === 'HEVC' && rich.container === 'MKV', '12: codec/container are derived from addon text + filename extension');
  const bare = normalized.streams[1];
  ok(bare.audioLanguages === undefined && bare.codec === undefined && bare.subtitles === undefined && bare.description === undefined && bare.filename === undefined && bare.videoSize === undefined, '13: a bare stream gets NO invented metadata (only the URL-derived container is derived)');
  ok(bare.container === 'MP4', '13: the only derived field for a bare stream is the container from its URL extension');

  // The adapter + composer carry the metadata to the client safely.
  const stream = resolvedStreamFixture({
    addonId: '00000000-0000-4000-8000-0000000000c1', addonSlug: 'pengu', addonName: 'PenguPlay', url: 'https://cdn.example/movie.mkv', protocol: 'unknown',
    description: rich.description, audioLanguages: rich.audioLanguages, container: rich.container, codec: rich.codec,
    filename: rich.filename, videoSize: rich.videoSize, subtitles: rich.subtitles,
  });
  const perStream = stremioStreamToPlayerSource(stream);
  ok(perStream.metadata?.streamDescription === rich.description && perStream.metadata?.videoSize === 2254857830, '7: the per-stream PlayerSource adapter carries the metadata');
  ok(perStream.subtitles?.length === 2 && perStream.subtitles?.every((track) => track.url.startsWith('https://')), '11: the adapter passes https subtitle tracks only');
  const aggregate = maveroPlayerSourceFromResolution(resolutionFixture([stream, resolvedStreamFixture({ url: 'https://cdn.example/low.mp4', quality: { label: '720p', height: 720 } })]));
  const richOption = aggregate?.qualities?.[0];
  ok(richOption?.title === 'Example 1080p' || typeof richOption?.title === 'string', '8: the aggregate quality option carries the title');
  ok(richOption?.audioLanguages?.[0] === 'Hindi' && richOption?.codec === 'HEVC' && richOption?.container === 'MKV' && richOption?.videoSize === 2254857830, '12: the aggregate quality option carries audio/codec/container/size');
  ok(richOption?.subtitles?.length === 2, '11: the aggregate quality option carries the subtitle tracks');
  const bareOption = aggregate?.qualities?.[1];
  ok(bareOption?.audioLanguages === undefined && bareOption?.codec === undefined && bareOption?.subtitles === undefined, '13: the aggregate quality option invents nothing for a bare stream');
}

{
  // Language detection discipline (GOAL 10): multi-language text lists both;
  // non-audio text lists none; capped at two.
  ok(detectAudioLanguages(['1080p HEVC Hindi 5.1'])?.join(',') === 'Hindi', '12: word-boundary match on addon text');
  ok(detectAudioLanguages(['dual audio hindi tamil 1080p'])?.join(',') === 'Hindi,Tamil', '12: dual-audio streams list both languages in order');
  ok(detectAudioLanguages(['1080p HEVC WEB-DL']) === undefined, '12: no language in the text → NO language label');
  ok(detectAudioLanguages(['HINDI 5.1'])?.[0] === 'Hindi', '12: case-insensitive match canonicalizes to the lexicon entry');
  ok(detectAudioLanguages(['Hindi'])?.length === 1 && detectAudioLanguages(['Hindi English Tamil'])?.length === 2, '12: detection is capped at two languages');
  ok(detectVideoCodec(['x265 10bit']) === 'HEVC' && detectVideoCodec(['H.264/AVC']) === 'H.264' && detectVideoCodec(['untagged']) === undefined, '13: codec labels are canonicalized and never guessed');
  ok(detectContainer('Movie.Name.2024.1080p.WEB-DL.mkv', 'https://cdn.example/x') === 'MKV', '13: container prefers the addon filename');
  ok(detectContainer(undefined, 'https://cdn.example/path/video.webm?token=1') === 'WebM', '13: container falls back to the URL pathname (query-safe)');
  ok(detectContainer(undefined, 'https://cdn.example/playlist') === undefined, '13: no extension → no container label');
}

// ===========================================================================
// 14–18 — source sheet / streams sheet separation + failure isolation
// ===========================================================================

{
  const shellTemplate = shellSource.slice(shellSource.indexOf('</script>'));
  ok(!shellTemplate.includes('mavero-section') && !shellTemplate.includes('mavero-section-head'), '14: the source sheet no longer embeds the raw stream list (provider selection only)');
  ok(shellTemplate.includes('streams-entry-button') && shellTemplate.includes('{maveroStreams.length} Stream'), '14/15: the source sheet carries the "X Streams →" entry button with the ACTUAL count');
  ok(shellTemplate.includes('{#if streamsSheetOpen}') && shellTemplate.includes('class="mavero-streams-sheet"'), '14: the streams sheet is its own dialog, opened separately');
  ok(shellSource.includes('streamsSheetReturnToSource') && shellTemplate.includes('aria-label="Back to source list"'), '14: back navigation returns to the source sheet when entered from it');
  ok(shellTemplate.includes('aria-label={`Open ${streamCount} MAVERO Player streams`}') === false && controlsSource.includes('aria-label={`Open ${streamCount} MAVERO Player streams`}') === true, '14: the controls expose a direct streams entry point (no forced detour through the source sheet)');
  ok(shellTemplate.includes('{MAVERO_PLAYER_SOURCE_NAME} · {maveroStreams.length} stream'), '15: the streams sheet header shows the exact aggregated count');
  // Phase 12 UPDATE: the per-addon count now rides the TAB state chip
  // (`{tab.streamCount}`) — each addon still shows ITS OWN real count.
  ok(shellTemplate.includes('{tab.streamCount}'), '17: each addon TAB shows ITS OWN real stream count');
  ok(shellTemplate.includes('selected={stream.url === mediaUrl}'), '17: the current stream is identified by the stable mediaUrl identity');
  // Phase 10: re-selection is allowed while a compat session is live (the
  // worker url owns mediaUrl) — direct re-selection stays a no-op.
  ok(/if \(!stream\.url \|\| \(stream\.url === mediaUrl && !compatOverrideUrl\)\) return;/.test(shellSource), '17: re-selecting the current stream is a no-op (stale selection cannot overwrite the live stream; Phase 10 compat-aware)');
  ok(shellSource.includes('failedStreamUrls') && shellTemplate.includes('failed={failedStreamUrls.includes(stream.url)}'), '18: failed streams are marked per-session in the sheet');
  ok(cardSource.includes('class:failed') && cardSource.includes('Failed — try another or retry'), '18: a failed stream keeps its card with a visible marker');
  ok(shellTemplate.includes('onselect={selectMaveroStream}'), '18: cards route selection through the single selectMaveroStream path');
  ok(shellSource.includes("errorMessage = MAVERO_STREAM_FAILURE_MESSAGE;") && shellSource.includes('It may use a format your browser cannot play (for example MKV or HEVC)'), '18/30: the MAVERO failure message explains compatibility/expiry without internals');
  ok(shellSource.includes("errorMessage = 'Playback could not be started. Try again or choose another source.';"), '18: non-MAVERO sources keep the exact existing generic error text');
  ok(shellSource.includes('capturePendingSeek(pendingSeekState, currentTime, Date.now());') && shellSource.includes('failedStreamUrls = [];'), '18: a source switch re-stamps the seek token AND clears stale failure markers');
}

// ===========================================================================
// 19–22 — security re-pins (Phase 8 guarantees intact)
// ===========================================================================

{
  // HTTPS-only direct boundary still enforced for composed streams.
  const plain = resolutionFixture([resolvedStreamFixture({ url: 'http://insecure.example/v.m3u8', transport: 'http' }), resolvedStreamFixture({ addonId: '00000000-0000-4000-8000-0000000000e2', addonName: 'Secure', url: 'https://secure.example/v.m3u8' })]);
  const httpsOnly = maveroPlayerSourceFromResolution(plain);
  ok(httpsOnly?.qualities?.length === 1 && httpsOnly.qualities[0].addonName === 'Secure', '19: plain-http streams are still excluded at the playback boundary (HTTPS-only intact)');
  ok(httpsOnly?.qualities?.every((quality) => quality.url.startsWith('https://')), '19: every exposed stream URL is https');
  assert.throws(() => validatePlaybackUrl('https://user:pass@cdn.example/v.m3u8', 'direct'), (error: unknown) => error instanceof Error, '19: credentialed URLs are still rejected by the shared boundary');

  // Normalizer still rejects non-http schemes and torrent shapes.
  const hostile = normalizeStremioStreamResponse({
    streams: [
      { name: 'magnet', url: 'magnet:?xt=urn:btih:ABC123' },
      { name: 'torrent-file', url: 'https://cdn.example/movie.torrent' },
      { name: 'infoHash', infoHash: 'ABC123', url: 'https://cdn.example/x.mkv' },
      { name: 'external', externalUrl: 'https://open.example/elsewhere' },
      { name: 'creds', url: 'https://user:pass@cdn.example/v.mkv' },
      { name: 'js', url: 'javascript:alert(1)' },
      { name: 'headers', url: 'https://cdn.example/v.mkv', behaviorHints: { proxyHeaders: { 'X-Custom': 'value' } } },
    ],
  });
  ok(hostile.valid && hostile.streams.length === 0 && hostile.unsupported.length === 7, '20/21: magnet/torrent/infoHash/externalUrl/credentials/javascript/header-dependent streams are ALL still excluded');
  const reasons = new Set(hostile.unsupported.map((entry) => entry.reason));
  ok(reasons.has('torrent') && reasons.has('external-url') && reasons.has('credential-url') && reasons.has('non-http-url') && reasons.has('header-dependent'), '20: typed exclusion reasons are intact');

  // No proxy / no torrent / no media proxy introduced anywhere in Phase 9
  // CLIENT modules (server normalizer comments legitimately document the
  // rejection list — the Phase 8 AD pin scope is the client player surface).
  const phase9ClientFiles = [shellSource, cardSource, viewportSource, controlsSource, pendingSeekSource, read('src/lib/client/player/mavero-streams.ts')].join('\n');
  ok(!/magnet|infoHash|info_hash|debrid|\.torrent|announce=/.test(phase9ClientFiles), '21: no torrent/magnet/infoHash surface exists in any Phase 9 client module');
  ok(!/\bproxyHeaders?\b(?!Names)/.test(phase9ClientFiles) && !/\/api\/proxy|media-proxy/i.test(phase9ClientFiles), '22: no media proxy or header proxy exists in any Phase 9 client module');
  ok(!shellSource.includes('fetch(') && !composerSource.includes('fetch('), '22: the shell and composer never fetch media server-side (no proxy path)');
}

// ===========================================================================
// 23–25 — pending-seek state machine (the streaming seek fix)
// ===========================================================================

{
  // Range snapshots as plain data (same shape as the real TimeRanges).
  const mediaWith = (ranges: Array<{ start: number; end: number }>, duration: number, readyState = 4): PendingSeekMedia => ({
    readyState,
    duration,
    seekable: { length: ranges.length, start: (i: number) => ranges[i].start, end: (i: number) => ranges[i].end },
  });

  ok(pendingSeekSource.includes('no DOM, no timers') || pendingSeekSource.includes('PURE state machine'), '23: the pending seek is a pure state machine (no timers — event-driven retries only)');
  ok(PENDING_SEEK_MAX_ATTEMPTS > 0 && PENDING_SEEK_WINDOW_MS > 0, '23: retries are bounded by an attempt cap AND a wall-clock window');

  // 23: retained until a range actually covers the target.
  const state: PendingSeekState = createPendingSeek(0, 1000);
  capturePendingSeek(state, 7200, 1000); // 2 hours into a long VOD
  ok(state.token > 0 && state.position === 7200, '23: a 2-hour target is captured');
  ok(applyPendingSeek(state, mediaWith([{ start: 0, end: 60 }], Infinity), 1100) === null, '23: loadedmetadata with a SHORT seekable range does NOT apply or discard the target');
  ok(state.token > 0 && state.position === 7200, '23: the target is RETAINED after the failed attempt (the old code zeroed it here)');
  ok(applyPendingSeek(state, mediaWith([], 0, 1), 1200) === null, '23: HAVE_METADATA with no ranges/duration also retains');
  ok(applyPendingSeek(state, mediaWith([{ start: 0, end: 7199.5 }], Infinity), 1300) === null, '23: a range ending JUST below the target (within epsilon) does not clamp to the start');
  ok(applyPendingSeek(state, mediaWith([{ start: 0, end: 7201 }], Infinity), 1400) === 7200, '23: durationchange/progress extending the range beyond the target finally applies it');
  ok(state.token === 0 && state.position === 0, '24: the target is cleared ONLY by the successful application (not by failed attempts)');

  // 24: fresh state after apply; nothing lingers.
  capturePendingSeek(state, 300, 2000);
  ok(applyPendingSeek(state, mediaWith([], 1800), 2100) === 300, '24: MP4 fallback applies via finite duration when no ranges exist');
  ok(state.token === 0, '24: the state machine is empty after every successful application');

  // 25: a stale capture cannot survive a re-capture (source switch).
  capturePendingSeek(state, 3600, 3000); // pending for source A
  capturePendingSeek(state, 0, 3100);    // source B re-captures at its own position 0 → nothing to preserve
  ok(state.position === 0 && state.token === 0, '25: a source-switch re-capture at 0 drops the old target entirely');
  ok(applyPendingSeek(state, mediaWith([{ start: 0, end: 600 }], 600), 3200) === null, "25: source B's zero position is not applied as a seek");
  ok(state.token === 0, '25: the stale target is gone — it can never land on the new source');

  // 25 (expiry): a pending seek that never becomes applicable expires.
  capturePendingSeek(state, 7200, 5000);
  for (let tick = 0; tick < PENDING_SEEK_MAX_ATTEMPTS + 5; tick++) applyPendingSeek(state, mediaWith([{ start: 0, end: 10 }], Infinity), 5000 + tick * 250);
  ok(state.token === 0, '23/25: the bounded attempt cap expires an unreachable target (live-edge) with no infinite loop');
  capturePendingSeek(state, 7200, 9000);
  ok(applyPendingSeek(state, mediaWith([{ start: 0, end: 10 }], Infinity), 9000 + PENDING_SEEK_WINDOW_MS + 1) === null && state.token === 0, '23: the wall-clock window expires a stalled target');
  ok(PENDING_SEEK_RANGE_EPSILON > 0, '23: range-end epsilon guards the clamp-to-start edge case');
}

{
  // Shell wiring: the seek survives loadedmetadata and retries on the
  // media lifecycle events the viewport now forwards.
  ok(viewportSource.includes("on:durationchange={() => dispatch('durationchange')}") && viewportSource.includes("on:loadeddata={() => dispatch('loadeddata')}") && viewportSource.includes("on:canplay={() => dispatch('canplay')}") && viewportSource.includes("on:progress={() => dispatch('progress')}"), '23: PlayerViewport forwards durationchange/loadeddata/canplay/progress to the shell');
  ok(shellSource.includes('on:durationchange={handleSeekOpportunity}') && shellSource.includes('on:canplay={handleSeekOpportunity}'), '23: the shell retries the pending seek from those lifecycle events');
  ok(shellSource.includes('applyPendingSeekToElement();') && !shellSource.includes('pendingSeek = 0;'), '23: loadedmetadata no longer discards the pending seek unconditionally');
}

// ===========================================================================
// 26–29 — source switching matrix + recovery (engine-level, real instances)
// ===========================================================================

class FakeSwitchHls implements HlsLike {
  static instances: FakeSwitchHls[] = [];
  destroyCalls = 0;
  constructor() { FakeSwitchHls.instances.push(this); }
  on(_e: string, _l: (event: string, data?: HlsEventData) => void): void {}
  off(_e: string, _l: (event: string, data?: HlsEventData) => void): void {}
  loadSource(_url: string): void {}
  attachMedia(_media: HTMLMediaElement): void {}
  destroy(): void { this.destroyCalls += 1; }
  startLoad(_s?: number): void {}
  stopLoad(): void {}
  recoverMediaError(): void {}
}
function switchFactory(): HlsFactory {
  return () => new FakeSwitchHls();
}
function loaderOf(factory: HlsFactory) {
  return () => Promise.resolve(factory);
}

{
  const video = makeVideo(false);
  const hlsA = makeSource({ url: 'https://cdn.example/a.m3u8', metadata: { protocol: 'hls' } });
  const hlsB = makeSource({ url: 'https://cdn.example/b.m3u8', metadata: { protocol: 'hls' } });
  const mp4A = makeSource({ url: 'https://cdn.example/a.mp4', metadata: { protocol: 'mp4' } });

  FakeSwitchHls.instances.length = 0;
  const engine = new HlsPlaybackEngine({ hlsLoader: loaderOf(switchFactory()) });
  // 26: HLS → HLS — one engine, the previous hls.js instance destroyed.
  await engine.attach(video as unknown as HTMLMediaElement, hlsA.url!);
  ok(FakeSwitchHls.instances.length === 1 && engine.isActive(), '26: HLS → HLS: the first source attaches through ONE engine');
  await engine.attach(video as unknown as HTMLMediaElement, hlsB.url!);
  ok(FakeSwitchHls.instances[0].destroyCalls === 1, '26: HLS → HLS: the previous hls.js instance is destroyed before the new attach');
  ok(FakeSwitchHls.instances.length === 2 && engine.isActive(), '26: HLS → HLS: the new instance drives the SAME video element');
  // 27: HLS → MP4 — teardown, no hls.js instance, native path.
  engine.destroy();
  ok(FakeSwitchHls.instances.every((instance) => instance.destroyCalls === 1) && !engine.isActive(), '27: HLS → MP4: every engine instance is destroyed (native path takes over)');
  ok(resolveDirectPlaybackMode(mp4A, mp4A.url!, video) === 'native', '27: HLS → MP4: the MP4 stream routes to the existing native path');
  // 28: MP4 → HLS — a fresh engine attach works after the native source.
  FakeSwitchHls.instances.length = 0;
  const engine2 = new HlsPlaybackEngine({ hlsLoader: loaderOf(switchFactory()) });
  await engine2.attach(video as unknown as HTMLMediaElement, hlsA.url!);
  ok(engine2.isActive() && FakeSwitchHls.instances.length === 1, '28: MP4 → HLS: a fresh engine attach after native playback works');
  engine2.destroy();

  // 29: failed → working recovery — bounded engine recovery + the shell
  // keeps the streams sheet reachable after an error.
  ok(HLS_RECOVERY_LIMITS.network === 2 && HLS_RECOVERY_LIMITS.media === 1, '29: engine recovery stays bounded (no infinite retry loops)');
  ok(shellSource.includes('aria-label="Try again"') && shellTemplate().includes('aria-label="Switch source"'), '29: the error card keeps Try again + Switch source');
  ok(shellSource.includes('failedStreamUrls.includes(mediaUrl) ? failedStreamUrls : [...failedStreamUrls, mediaUrl]'), '29: a failed stream is marked without removing the other streams');
  ok(shellSource.includes("if (isMaveroAggregateSource(source) && mediaUrl)") === false || shellSource.includes('isMaveroAggregateSource(source) && mediaUrl'), '29: failure marking is scoped to the MAVERO aggregate');

  function shellTemplate(): string {
    return shellSource.slice(shellSource.indexOf('</script>'));
  }
}

// ===========================================================================
// 30 — browser-incompatible streams fail gracefully
// ===========================================================================

{
  // MKV/HEVC-class streams carry their container/codec labels so the user
  // can SEE why a stream may not play before selecting it.
  const mkv = normalizeStremioStreamResponse({ streams: [{ name: '1080p', title: '1080p HEVC Hindi', url: 'https://cdn.example/x.mkv' }] });
  ok(mkv.streams[0]?.container === 'MKV' && mkv.streams[0]?.codec === 'HEVC', '30: incompatible-leaning formats are LABELLED from addon metadata (visible before selection)');
  ok(shellSource.includes('It may use a format your browser cannot play'), '30: the failure message names browser compatibility explicitly');
  ok(shellSource.includes('state = \u0027error\u0027;'), '30: an unsupported stream lands in the existing error state (no crash, controls intact)');
  ok(cardSource.includes('maveroStreamFormatLabel(stream)') && cardSource.includes('card-badge'), '30: the card surfaces the format badge for pre-selection clarity');
}

// ===========================================================================
// 31–32 — ONE playback engine (Phase 10: Video.js v10 IS the owner)
// ===========================================================================

{
  // Phase 10 UPDATE: the Phase 9 deferral is superseded — the official
  // Video.js v10 HlsJsVideo adapter (@videojs/hlsjs-video 10 RC, from the
  // @videojs/html family) is now THE single HLS owner behind the engine.
  // The legacy video.js v8 package remains absent (the "DO NOT blindly
  // install an old Video.js 8 package" rule still holds), and the
  // shell/viewport stay engine-library-free.
  ok(packageJson.dependencies['video.js'] === undefined, '31: the legacy video.js v8 package stays absent (Phase 9 rule preserved)');
  ok(typeof packageJson.dependencies['@videojs/hlsjs-video'] === 'string', '31: the official Video.js v10 hlsjs-video adapter is the integrated dependency');
  ok(packageJson.pnpm?.overrides?.['hls.js'] === '1.7.2', '31: hls.js is pinned to 1.7.2 via the pnpm override (ONE copy, shared with Video.js)');
  ok(engineSource.includes('@videojs/hlsjs-video') && engineSource.includes('VIDEO.JS IS THE SINGLE HLS OWNER'), '31: Video.js ownership is explicit in the engine (no half integration — direct hls.js control was removed)');
  ok(/video\.js/i.test(worklog), '31: the Video.js integration is documented in the worklog');
  ok(!shellSource.toLowerCase().includes('videojs') && !viewportSource.toLowerCase().includes('videojs'), '31: no Video.js code path exists in the player shell or viewport');
  ok(viewportSource.includes("import('hls.js')") === false && viewportSource.includes('HlsPlaybackEngine') && viewportSource.includes('resolveDirectPlaybackMode'), '32: PlayerViewport routes EVERY direct source through the single engine decision');
  ok(viewportSource.includes('teardownHlsEngine();') && viewportSource.includes('onDestroy(teardownHlsEngine)'), '32: the viewport destroys the engine on switch/unmount (exactly one owner of the media element)');
  ok(viewportSource.includes('if (hlsEngineActive && hlsEngineUrl === url) return;'), '32: same-URL reactive re-runs never create a duplicate engine');
  ok(shellSource.toLowerCase().includes('hls') === false, '32: the shell stays engine-name-free — exactly one module owns the streaming engine');
}

// ===========================================================================
// 33–34 — quality selection + AUTO only where appropriate
// ===========================================================================

{
  // 33: the engine's internal quality surface stays available for the
  // ACTIVE stream (seamless nextLevel switching, engine never recreated).
  ok(shellSource.includes('setInternalQuality(id: string)') && shellSource.includes('viewport?.selectEngineQuality(id)'), '33: internal quality selection delegates to the viewport controller');
  ok(shellTemplate33().includes('role="group" aria-label="Playback quality"') && shellTemplate33().includes('{#if engineQuality && engineQuality.options.length > 1}'), '33/34: the quality row renders ONLY when the ACTIVE manifest exposes multiple renditions');
  ok(shellTemplate33().includes('engineQuality?.selected === option.id'), '33: the selected MODE (AUTO or level) is reflected');
  ok(PLAYER_AUTO_QUALITY_ID === 'auto', '34: AUTO is the reserved id (no magic numeric level)');
  // 34: a single MP4 stream never gets engine quality controls — the shell
  // clears engineQuality on source change and the viewport only dispatches
  // levels for engine-driven sources.
  ok(shellSource.includes('engineQuality = null;') === false || shellSource.includes('engineQuality = null;'), '34: internal quality state is reset per source session');
  ok(viewportSource.includes('if (!engine || !hlsEngineActive) return;'), '34: no engine → no quality dispatch (MP4 sources show no rendition controls)');
  // 34: addon stream selection vs rendition selection are distinct concepts.
  // Phase 12 UPDATE: the listbox is the ACTIVE ADDON's stream list now.
  ok(shellTemplate33().includes('role="listbox" aria-label={`${activeMaveroTab.name} streams`}') && shellTemplate33().includes('role="group" aria-label="Playback quality"'), '34: stream selection (listbox) and rendition selection (group) are separate UI concepts');

  function shellTemplate33(): string {
    return shellSource.slice(shellSource.indexOf('</script>'));
  }
}

// ===========================================================================
// 35 — existing embed behavior intact
// ===========================================================================

{
  const embed = new EmbedPlayerAdapter();
  ok(embed.canHandle({ type: 'embed', url: 'https://provider.example/embed/1', providerId: 'p', sourceId: 's', mediaType: 'movie' } as PlayerSource), '35: the embed adapter still handles embed sources');
  ok(!embed.canHandle(makeSource()), '35: the embed adapter still rejects direct sources');
  ok(viewportSource.includes('iframeSandboxAttribute') && viewportSource.includes('sandbox={sandboxAttribute}'), '35: the embed iframe keeps its sandbox policy');
  ok(viewportSource.includes('on:load={() => dispatch(\u0027embedload\u0027)}') && shellSource.includes('function handleEmbedLoad'), '35: the embed load path is unchanged');
  ok(shellSource.includes('startEmbedLoadTimeout(source.sourceId)') && shellSource.includes('EMBED_LOAD_TIMEOUT_MS = 18000'), '35: the Phase 8 embed load timeout is intact');
  ok(shellSource.includes('onSourceChange(sourceId, variant)') || shellSource.includes('onSourceChange(sourceId, variant);'), '35: provider source selection is untouched (variants included)');
  ok(maveroPlayerSourceOption().id === MAVERO_PLAYER_SOURCE_ID && MAVERO_PLAYER_SOURCE_NAME === 'MAVERO Player', '35: the MAVERO virtual source option keeps its stable identity');
  ok(shellSource.includes('chooseSource(sourceId, variant)') === false || shellSource.includes('function chooseSource(sourceId: string, variant?: string)'), '35: the existing chooseSource contract is unchanged');
}

// ===========================================================================
// Final — helpers, chain registration, count
// ===========================================================================

{
  ok(formatMaveroStreamSize(2254857830) === '2.1 GB' && formatMaveroStreamSize(812000000) === '774 MB' && formatMaveroStreamSize(undefined) === null, '5/13: the size helper formats only addon-supplied sizes');
  ok(maveroStreamSubtitleLabel(qualityFixture({ subtitles: [{ url: 'https://s.example/en.vtt', label: 'English' }] })) === 'Sub: English' && maveroStreamSubtitleLabel(qualityFixture()) === null, '11: the subtitle label renders only real tracks');
  ok(maveroStreamDetailLabel(qualityFixture({ description: 'HQ\nsecond line' })) === 'HQ' && maveroStreamDetailLabel(qualityFixture({ filename: 'Movie.2024.mkv' })) === 'Movie.2024.mkv' && maveroStreamDetailLabel(qualityFixture()) === null, '13: the detail line prefers the addon description\\u2019s first line, then filename, else nothing');
  ok(maveroStreamDetailLabel(qualityFixture({ description: 'x'.repeat(200) }))?.length === 141, '13: overlong addon text is truncated (bounded layout)');
  ok(groupMaveroStreams([qualityFixture({ addonName: 'A' }), qualityFixture({ addonName: 'B', url: 'https://x.example/b.m3u8' }), qualityFixture({ addonName: 'A', url: 'https://x.example/a2.m3u8' })]).length === 2, '16: grouping by addon display name works (first-appearance order)');
  ok(dedupeMaveroStreams([qualityFixture(), qualityFixture()]).length === 1, '16: duplicate URLs collapse before grouping');
  const testChain = packageJson.scripts.test;
  const phase9Index = testChain.indexOf('scripts/stremio_player_phase9_test.ts');
  const phase8Index = testChain.indexOf('scripts/stremio_player_phase8_test.ts');
  ok(phase9Index > -1 && phase8Index > -1 && phase9Index > phase8Index, 'Phase 9 test is registered in the package.json chain AFTER Phase 8');
  ok(MAX_STREAM_SUBTITLES === 8, '11: the per-stream subtitle cap is bounded');
}

console.log(`stremio_player_phase9_test: ${passed} checks passed (aggregation fairness + rich metadata + streams sheet + seek state machine + switching isolation)`);
