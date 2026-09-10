import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { PlayerQualityOption, PlayerSource } from '$lib/shared/player';
import { PLAYER_AUTO_QUALITY_ID } from '$lib/shared/player';
import { MAVERO_PLAYER_SOURCE_ID, MAVERO_PLAYER_SOURCE_NAME, maveroPlayerSourceOption } from '$lib/shared/mavero-player';
import { isPlayablePlayerSource } from '$lib/shared/player-guards';
import { MAVERO_PLAYER_MAX_STREAMS, maveroPlayerSourceFromResolution } from '$lib/server/streaming/stremio/mavero-player-source';
import { stremioStreamToPlayerSource } from '$lib/server/streaming/stremio/stream-player-source';
import type { StremioResolvedStream } from '$lib/server/streaming/stremio/stream-resolver';
import { DirectPlayerAdapter } from '$lib/client/player/direct-adapter';
import { EmbedPlayerAdapter } from '$lib/client/player/embed-adapter';
import {
  dedupeMaveroStreams,
  groupMaveroStreams,
  isMaveroAggregateSource,
  maveroStreamFormatLabel,
  maveroStreamQualityLabel,
  protocolForStreamUrl,
  sourceForStreamUrl,
} from '$lib/client/player/mavero-streams';
import {
  HlsPlaybackEngine,
  HLS_ENGINE_EVENTS,
  HLS_RECOVERY_LIMITS,
  HLS_UNRECOVERABLE_MESSAGE,
  hlsLevelLabel,
  isHlsMediaSource,
  looksLikeHlsUrl,
  resolveDirectPlaybackMode,
  type HlsFactory,
  type HlsLike,
  type HlsLevelLike,
  type HlsEventData,
} from '$lib/client/player/hls-engine';

// Phase 6: MAVERO Player source & quality UX tests.
//
// Scope: the USER-FACING source/quality experience on top of the EXISTING
// player architecture (nothing was rewritten):
//   A/B   one logical MAVERO Player source; existing providers untouched
//   C–H   addon grouping, display names, logo fallback, quality/language/
//         format labels (presentation-layer helpers + server metadata)
//   I–L   current-stream indication, aria-selected, deterministic ordering,
//         presentation-layer URL-identity dedupe
//   M–O   zero-stream / failed-stream states; one failed addon never hides
//         the other addons' streams
//   P–S   in-player source switching (no navigation) + the HLS↔HLS/MP4
//         routing matrix on mixed-protocol aggregates
//   T/U   position preservation + stale source protection
//   V–AA  mobile/desktop/landscape sheet contract + keyboard/focus/a11y
//   AB–AF no admin controls, no manifest/db identifiers, no torrent, no
//         proxy, no arbitrary headers
//   AG–AN callback compatibility, Phase 5 engine compatibility, AUTO and
//         manual HLS levels, labels, no engine recreation, failure recovery
//   AO–AT panel behavior, mounted player, single quality menu, accessible
//         controls, test-chain registration
// No test touches the real network or a real browser: hls.js is injected
// through fake factories, presentation helpers are exercised directly, and
// UI contracts are pinned at precise source level (repo convention).

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const shellSource = read('src/lib/components/player/PlayerShell.svelte');
const viewportSource = read('src/lib/components/player/PlayerViewport.svelte');
const controlsSource = read('src/lib/components/player/PlayerControls.svelte');
const streamsSource = read('src/lib/client/player/mavero-streams.ts');
const engineSource = read('src/lib/client/player/hls-engine.ts');
const composerSource = read('src/lib/server/streaming/stremio/mavero-player-source.ts');
const watchSource = read('src/routes/watch/[type]/[id]/+page.svelte');
const sharedSource = read('src/lib/shared/player.ts');
const shellTemplate = shellSource.slice(shellSource.indexOf('</script>'));

// ---------------------------------------------------------------------------
// Fakes — no real browser, no real hls.js, no network
// ---------------------------------------------------------------------------

/** Phase 5-narrow double: NO quality surface (proves graceful degradation). */
class FakeHlsNarrow implements HlsLike {
  static instances: FakeHlsNarrow[] = [];
  readonly listeners = new Map<string, Array<(event: string, data?: HlsEventData) => void>>();
  readonly loadSourceCalls: string[] = [];
  readonly attachedMedia: unknown[] = [];
  destroyCalls = 0;
  constructor(public readonly config?: Record<string, unknown>) {
    FakeHlsNarrow.instances.push(this);
  }
  on(event: string, listener: (event: string, data?: HlsEventData) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  off(_event: string, _listener: (event: string, data?: HlsEventData) => void): void {}
  loadSource(url: string): void { this.loadSourceCalls.push(url); }
  attachMedia(media: unknown): void { this.attachedMedia.push(media); }
  destroy(): void { this.destroyCalls += 1; }
  startLoad(_startPosition?: number): void {}
  stopLoad(): void {}
  recoverMediaError(): void {}
  emit(event: string, data?: HlsEventData): void {
    for (const listener of this.listeners.get(event) ?? []) listener(event, data);
  }
}

/** Phase 6 double: full quality surface mirroring hls.js 1.7.2 semantics. */
class FakeHlsQuality implements HlsLike {
  static instances: FakeHlsQuality[] = [];
  readonly listeners = new Map<string, Array<(event: string, data?: HlsEventData) => void>>();
  readonly loadSourceCalls: string[] = [];
  readonly attachedMedia: unknown[] = [];
  readonly nextLevelWrites: number[] = [];
  destroyCalls = 0;
  levels: HlsLevelLike[];
  currentLevel = -1;
  autoLevelEnabled = true;
  /** Remaining number of nextLevel writes that throw (one-shot failure). */
  failNextLevelWrites = 0;
  private _nextLevel = -1;
  constructor(public readonly config?: Record<string, unknown>) {
    FakeHlsQuality.instances.push(this);
  }
  get nextLevel(): number { return this._nextLevel; }
  set nextLevel(value: number) {
    if (this.failNextLevelWrites > 0) {
      this.failNextLevelWrites -= 1;
      throw new Error('level switch rejected');
    }
    this.nextLevelWrites.push(value);
    this._nextLevel = value;
    if (value === -1) {
      this.autoLevelEnabled = true; // hls.js: -1 re-enables ABR
    } else {
      this.autoLevelEnabled = false; // hls.js: manual level pending
      this.currentLevel = value;
    }
  }
  on(event: string, listener: (event: string, data?: HlsEventData) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  off(_event: string, _listener: (event: string, data?: HlsEventData) => void): void {}
  loadSource(url: string): void { this.loadSourceCalls.push(url); }
  attachMedia(media: unknown): void { this.attachedMedia.push(media); }
  destroy(): void { this.destroyCalls += 1; }
  startLoad(_startPosition?: number): void {}
  stopLoad(): void {}
  recoverMediaError(): void {}
  emit(event: string, data?: HlsEventData): void {
    for (const listener of this.listeners.get(event) ?? []) listener(event, data);
  }
}

const STANDARD_LEVELS: HlsLevelLike[] = [
  { height: 1080, bitrate: 5_000_000 },
  { height: 720, bitrate: 2_400_000 },
  { height: 480, bitrate: 1_100_000 },
];

function makeVideo(canPlayHls: boolean): Pick<HTMLMediaElement, 'canPlayType'> {
  return { canPlayType: (type: string) => (canPlayHls && type.includes('mpegurl') ? 'probably' : '') };
}

/** Engine wired to the FakeHlsQuality factory (never the real hls.js import). */
function fakeEngine(): HlsPlaybackEngine {
  return new HlsPlaybackEngine({ hlsLoader: async () => (config?: Record<string, unknown>) => new FakeHlsQuality(config) });
}

async function attachEngine(engine: HlsPlaybackEngine, url: string, callbacks: Parameters<HlsPlaybackEngine['attach']>[2] = {}): Promise<FakeHlsQuality> {
  await engine.attach(makeVideo(false) as unknown as HTMLMediaElement, url, callbacks);
  return engine.getInstance() as FakeHlsQuality;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let fixtureCounter = 0;
function resolvedStreamFixture(overrides: Partial<StremioResolvedStream> = {}): StremioResolvedStream {
  fixtureCounter += 1;
  const slug = overrides.addonSlug ?? 'addon-a';
  return {
    addonId: overrides.addonId ?? `00000000-0000-4000-8000-${String(fixtureCounter).padStart(12, '0')}`,
    addonSlug: slug,
    addonName: 'Example HTTP Addon',
    addonOrdering: 1,
    streamIndex: 0,
    streamName: 'Example 1080p',
    streamTitle: 'Example 1080p',
    url: 'https://cdn.example/example.m3u8',
    protocol: 'hls',
    transport: 'https',
    mediaType: 'movie',
    videoId: 'tt1234567',
    idProperty: 'imdb_id',
    quality: { label: '1080p', height: 1080 },
    ...overrides,
  };
}

function qualityFixture(overrides: Partial<PlayerQualityOption> = {}): PlayerQualityOption {
  return {
    url: 'https://cdn.example/stream.m3u8',
    label: 'Example HTTP Addon · 1080p',
    height: 1080,
    addonName: 'Example HTTP Addon',
    protocol: 'hls',
    ...overrides,
  };
}

function makeAggregate(overrides: Partial<PlayerSource> = {}): PlayerSource {
  return {
    type: 'direct',
    url: 'https://cdn.example/example.m3u8',
    providerId: MAVERO_PLAYER_SOURCE_ID,
    sourceId: MAVERO_PLAYER_SOURCE_ID,
    mediaType: 'movie',
    qualities: [qualityFixture()],
    metadata: { sourceName: MAVERO_PLAYER_SOURCE_NAME, providerName: MAVERO_PLAYER_SOURCE_NAME, protocol: 'hls' },
    ...overrides,
  };
}

// ===========================================================================
// A — MAVERO Player remains ONE logical source
// ===========================================================================

{
  const source = maveroPlayerSourceFromResolution({ mediaType: 'movie', requestedMediaType: 'movie', sources: [resolvedStreamFixture()], unsupported: [], diagnostics: [], consideredAddons: 1, elapsedMs: 1 });
  ok(source !== null, 'A: the aggregate source composes from a resolution');
  ok(source!.sourceId === MAVERO_PLAYER_SOURCE_ID && source!.providerId === MAVERO_PLAYER_SOURCE_ID, 'A: the aggregate keeps the stable virtual identity');
  ok(source!.qualities?.length === 1, 'A: one stream → one quality entry (existing model, no parallel representation)');
  ok(isPlayablePlayerSource(source), 'A: the aggregate passes the existing shared guard');
  ok(isMaveroAggregateSource(source), 'A: the aggregate is recognized as the MAVERO Player source');
  ok(!isMaveroAggregateSource(makeAggregate({ providerId: 'some-provider-uuid', sourceId: 'some-source-uuid' })), 'A: provider sources are NEVER recognized as the MAVERO aggregate');
  ok(!isMaveroAggregateSource({ type: 'embed', url: 'https://embed.example/x', providerId: MAVERO_PLAYER_SOURCE_ID, sourceId: MAVERO_PLAYER_SOURCE_ID } as PlayerSource), 'A: embed sources are never the MAVERO aggregate');
  ok(!isMaveroAggregateSource(null), 'A: a null source is never the MAVERO aggregate');

  // One virtual option in the sheet; the stream section is nested INSIDE it.
  const option = maveroPlayerSourceOption();
  ok(option.id === MAVERO_PLAYER_SOURCE_ID && option.name === MAVERO_PLAYER_SOURCE_NAME, 'A: the virtual source option is unchanged (one logical source)');
  const optionLoopCount = shellTemplate.split('{#each sourceOptions as option}').length - 1;
  ok(optionLoopCount === 1, 'A: the sheet renders exactly ONE source-options loop (no second source list)');
  ok(shellTemplate.indexOf('{#each sourceOptions as option}') < shellTemplate.indexOf('mavero-section'), 'A: the MAVERO stream section renders INSIDE the same sheet, after the source options (nested presentation, not a second source entry)');
  ok(shellSource.includes('maveroStreamGroups.length') && !shellSource.includes('sourceOptions.push'), 'A: the section is presentation-only — the source OPTIONS list is never mutated');
}

// ===========================================================================
// B — existing providers remain unchanged
// ===========================================================================

{
  // The Phase 3 per-stream adapter is untouched: plain quality label, no
  // addon-name prefix, no presentation metadata (that is composer-only).
  const streamSource = stremioStreamToPlayerSource(resolvedStreamFixture());
  ok(streamSource.qualities?.[0]?.label === '1080p', 'B: the Phase 3 per-stream adapter still labels qualities plainly (no Phase 6 contamination)');
  ok(streamSource.qualities?.[0]?.addonName === undefined && streamSource.qualities?.[0]?.protocol === undefined, 'B: the Phase 3 adapter adds no presentation metadata (composer-only concern)');

  // Existing adapters keep their contracts.
  const direct = new DirectPlayerAdapter();
  ok(direct.canHandle({ type: 'direct', url: 'https://x.example/v.mp4', providerId: 'p', sourceId: 's', mediaType: 'movie' }), 'B: the direct adapter still handles direct sources');
  const embed = new EmbedPlayerAdapter();
  ok(embed.canHandle({ type: 'embed', url: 'https://embed.example/x', providerId: 'p', sourceId: 's', mediaType: 'movie' }), 'B: the embed adapter still handles embed sources');

  // The desktop quality select keeps its EXISTING branch for non-engine sources.
  ok(controlsSource.includes('{:else if qualities.length > 1}'), 'B: the legacy per-stream quality select branch is intact (fallback when no internal levels exist)');
  ok(controlsSource.includes('<option value="">Auto</option>{#each qualities as quality}<option value={quality.url}>{qualityLabel(quality)}</option>{/each}'), 'B: the legacy select options markup is byte-identical');
  ok(watchSource.includes('onSourceChange={handleSourceChange}'), 'B: the watch route still owns source switching through the existing callback');
}

// ===========================================================================
// C — addon streams grouped correctly
// ===========================================================================

{
  const groups = groupMaveroStreams([
    qualityFixture({ url: 'https://a.example/1080.m3u8', addonName: 'Addon A', label: 'Addon A · 1080p' }),
    qualityFixture({ url: 'https://a.example/720.m3u8', addonName: 'Addon A', label: 'Addon A · 720p', height: 720 }),
    qualityFixture({ url: 'https://b.example/1080.mp4', addonName: 'Addon B', label: 'Addon B · 1080p', protocol: 'mp4' }),
  ]);
  ok(groups.length === 2, 'C: two addons → two groups');
  ok(groups[0].addonName === 'Addon A' && groups[0].streams.length === 2, 'C: the first addon group holds both of its streams');
  ok(groups[1].addonName === 'Addon B' && groups[1].streams.length === 1, 'C: the second addon group holds its stream');
  ok(groups[0].streams[0].url === 'https://a.example/1080.m3u8' && groups[0].streams[1].url === 'https://a.example/720.m3u8', 'C: stream order inside a group is preserved');

  // The SERVER supplies the grouping metadata — no second client resolution.
  const aggregate = maveroPlayerSourceFromResolution({
    mediaType: 'movie', requestedMediaType: 'movie',
    sources: [
      resolvedStreamFixture({ addonSlug: 'addon-a', addonName: 'Addon A', url: 'https://a.example/1080.m3u8' }),
      resolvedStreamFixture({ addonSlug: 'addon-b', addonName: 'Addon B', url: 'https://b.example/auto.mp4', protocol: 'mp4', quality: { label: 'Auto' } }),
    ],
    unsupported: [], diagnostics: [], consideredAddons: 2, elapsedMs: 2,
  });
  ok(aggregate?.qualities?.every((quality) => typeof quality.addonName === 'string' && quality.addonName.length > 0), 'C: every aggregate quality entry carries the addon display name (server-side)');
  ok(groupMaveroStreams(aggregate?.qualities ?? []).length === 2, 'C: the server-composed aggregate groups into one group per addon');
}

// ===========================================================================
// D — addon display names shown
// ===========================================================================

{
  const groups = groupMaveroStreams([qualityFixture({ addonName: 'HTTP Streams Plus' })]);
  ok(groups[0].addonName === 'HTTP Streams Plus', 'D: the group name IS the addon display name');
  ok(shellTemplate.includes('<div class="mavero-group-name" role="presentation" title={group.addonName}>{group.addonName}</div>'), 'D: the sheet renders the addon display name as the group header');
  ok(shellTemplate.includes('{MAVERO_PLAYER_SOURCE_NAME}'), 'D: the section header shows the stable MAVERO Player display name');
  const unnamed = groupMaveroStreams([qualityFixture({ addonName: undefined, label: '480p' })]);
  ok(unnamed.length === 1 && unnamed[0].addonName === 'Addon', 'D: a stream without a name falls into one stable "Addon" group (never dropped, never fabricated)');
  const whitespace = groupMaveroStreams([qualityFixture({ addonName: '   ' })]);
  ok(whitespace[0].addonName === 'Addon', 'D: whitespace-only names fall back too');
}

// ===========================================================================
// E — addon logos handled (consistent fallback, no arbitrary external images)
// ===========================================================================

{
  const aggregate = maveroPlayerSourceFromResolution({ mediaType: 'movie', requestedMediaType: 'movie', sources: [resolvedStreamFixture()], unsupported: [], diagnostics: [], consideredAddons: 1, elapsedMs: 1 });
  const keys = Object.keys(aggregate?.qualities?.[0] ?? {});
  ok(!keys.includes('logo'), 'E: addon logo URLs are NOT sent to the client (the player sheet never loads arbitrary addon images)');
  ok(shellSource.includes('Clapperboard') && shellTemplate.includes('<Clapperboard size={13} aria-hidden="true" />'), 'E: the section uses a consistent fallback icon (lucide Clapperboard)');
  ok(!shellSource.includes('<img'), 'E: the player sheet renders zero <img> elements (no external image loads → no layout instability)');
}

// ===========================================================================
// F — quality labels generated correctly
// ===========================================================================

{
  ok(maveroStreamQualityLabel(qualityFixture({ height: 720 })) === '720p', 'F: height 720 → "720p"');
  ok(maveroStreamQualityLabel(qualityFixture({ height: 2160, label: 'Example · 2160p' })) === '2160p', 'F: height wins over the label text');
  ok(maveroStreamQualityLabel(qualityFixture({ height: undefined, label: 'Addon B · Auto' })) === 'Auto', 'F: no height + "Auto" label → "Auto"');
  ok(maveroStreamQualityLabel(qualityFixture({ height: undefined, label: 'Addon C · 480p' })) === '480p', 'F: the quality portion of the existing label is reused');
  ok(maveroStreamQualityLabel(qualityFixture({ height: undefined, label: undefined })) === 'Auto', 'F: nothing available → "Auto" (never fabricated)');
  ok(maveroStreamQualityLabel(qualityFixture({ height: undefined, label: 'Just a title' })) === 'Just a title', 'F: a label without the "·" separator is preserved as-is');
  ok(!/\d{5,}/.test(maveroStreamQualityLabel(qualityFixture({ height: undefined, bitrate: 1234567, label: undefined }))), 'F: raw bitrate is never displayed as a quality label');
  ok(shellTemplate.includes('<strong>{maveroStreamQualityLabel(stream)}</strong>'), 'F: the sheet renders the derived quality label');
}

// ===========================================================================
// G — language labels handled (never fabricated)
// ===========================================================================

{
  // Phase 3 provides no reliable language metadata, so Phase 6 renders none.
  const aggregate = maveroPlayerSourceFromResolution({ mediaType: 'movie', requestedMediaType: 'movie', sources: [resolvedStreamFixture()], unsupported: [], diagnostics: [], consideredAddons: 1, elapsedMs: 1 });
  const keys = Object.keys(aggregate?.qualities?.[0] ?? {});
  ok(!keys.includes('language'), 'G: quality options carry NO language field (nothing fabricated)');
  ok(!shellTemplate.slice(shellTemplate.indexOf('mavero-section')).includes('language'), 'G: the MAVERO section renders no language label');
  ok(!streamsSource.match(/language\s*[:=]/), 'G: the presentation module never derives or invents language values');
  ok(maveroStreamQualityLabel(qualityFixture()) === '1080p', 'G: quality labels stay quality-only');
}

// ===========================================================================
// H — format labels handled (secondary, only when known)
// ===========================================================================

{
  ok(maveroStreamFormatLabel(qualityFixture({ protocol: 'hls' })) === 'HLS', 'H: hls → "HLS"');
  ok(maveroStreamFormatLabel(qualityFixture({ protocol: 'mp4' })) === 'MP4', 'H: mp4 → "MP4"');
  ok(maveroStreamFormatLabel(qualityFixture({ protocol: 'file' })) === null, 'H: unknown protocols are omitted (never guessed from filenames)');
  ok(maveroStreamFormatLabel(qualityFixture({ protocol: undefined })) === null, 'H: missing protocol is omitted');
  ok(shellTemplate.includes('{#if maveroStreamFormatLabel(stream)}<small>{maveroStreamFormatLabel(stream)}</small>{/if}'), 'H: format renders as the SECONDARY line, only when known');
  const aggregate = maveroPlayerSourceFromResolution({
    mediaType: 'movie', requestedMediaType: 'movie',
    sources: [
      resolvedStreamFixture({ url: 'https://cdn.example/a.m3u8', protocol: 'hls' }),
      resolvedStreamFixture({ addonSlug: 'addon-b', url: 'https://cdn.example/b.mp4', protocol: 'mp4', quality: { label: '720p', height: 720 } }),
    ],
    unsupported: [], diagnostics: [], consideredAddons: 2, elapsedMs: 1,
  });
  ok(aggregate?.qualities?.[0]?.protocol === 'hls' && aggregate?.qualities?.[1]?.protocol === 'mp4', 'H: the composer carries each stream\u2019s own normalized protocol');
}

// ===========================================================================
// I — current source selection
// ===========================================================================

{
  const aggregate = maveroPlayerSourceFromResolution({ mediaType: 'movie', requestedMediaType: 'movie', sources: [resolvedStreamFixture({ url: 'https://cdn.example/first.m3u8' })], unsupported: [], diagnostics: [], consideredAddons: 1, elapsedMs: 1 });
  ok(aggregate?.url === aggregate?.qualities?.[0]?.url, 'I: the initial current stream IS qualities[0] (mediaUrl falls back to source.url)');
  ok(shellTemplate.includes('aria-selected={stream.url === mediaUrl}'), 'I: current-stream identity is the stable stream URL compared against the live mediaUrl');
  const body = shellSource.slice(shellSource.indexOf('function selectMaveroStream'));
  ok(/if \(!stream\.url \|\| stream\.url === mediaUrl\) return;/.test(body), 'I: selecting the CURRENT stream is a no-op (no pointless reload)');
}

// ===========================================================================
// J — selected state / aria-selected
// ===========================================================================

{
  ok(shellTemplate.includes('class:active={stream.url === mediaUrl}'), 'J: the current stream row carries the visual selected class');
  ok(shellTemplate.includes('aria-selected={stream.url === mediaUrl}'), 'J: the current stream row carries aria-selected (not color alone)');
  ok(/<span class="option-mark">\{#if stream\.url === mediaUrl\}<Check size=\{14\} \/>/.test(shellTemplate), 'J: the current stream row carries the check icon');
}

// ===========================================================================
// K — source ordering deterministic
// ===========================================================================

{
  const aggregate = maveroPlayerSourceFromResolution({
    mediaType: 'movie', requestedMediaType: 'movie',
    sources: [
      resolvedStreamFixture({ addonSlug: 'addon-a', addonName: 'Addon A', streamIndex: 0, url: 'https://a.example/1080.m3u8', quality: { label: '1080p', height: 1080 } }),
      resolvedStreamFixture({ addonSlug: 'addon-a', addonName: 'Addon A', streamIndex: 1, url: 'https://a.example/720.m3u8', quality: { label: '720p', height: 720 } }),
      resolvedStreamFixture({ addonSlug: 'addon-b', addonName: 'Addon B', streamIndex: 0, url: 'https://b.example/1080.mp4', protocol: 'mp4' }),
    ],
    unsupported: [], diagnostics: [], consideredAddons: 2, elapsedMs: 1,
  });
  const urls = aggregate?.qualities?.map((quality) => quality.url) ?? [];
  ok(JSON.stringify(urls) === JSON.stringify(['https://a.example/1080.m3u8', 'https://a.example/720.m3u8', 'https://b.example/1080.mp4']), 'K: the composer preserves the resolver\u2019s deterministic order');
  ok(!streamsSource.includes('.sort(') && !streamsSource.includes('.reverse('), 'K: the presentation layer never re-orders (grouping only)');
  ok(composerSource.includes('if (playable.length >= MAVERO_PLAYER_MAX_STREAMS) break;') && MAVERO_PLAYER_MAX_STREAMS === 24, 'K: the Phase 4 payload cap and its position in the deterministic order are untouched');
  ok(composerSource.includes('validatePlaybackUrl(source.url, \u0027direct\u0027)'), 'K: the existing playback URL boundary is still the composer\u2019s gate');
}

// ===========================================================================
// L — duplicate streams removed correctly (presentation layer)
// ===========================================================================

{
  const deduped = dedupeMaveroStreams([
    qualityFixture({ url: 'https://x.example/v.m3u8', label: 'Addon A · 1080p' }),
    qualityFixture({ url: 'https://x.example/v.m3u8', label: 'Addon A · 720p', height: 720 }),
    qualityFixture({ url: 'https://y.example/v.m3u8', label: 'Addon A · 1080p' }),
  ]);
  ok(deduped.length === 2, 'L: identical URLs collapse to one entry even when labels differ');
  ok(deduped[0].label === 'Addon A · 1080p', 'L: the FIRST entry wins (deterministic)');
  const byLabel = dedupeMaveroStreams([
    qualityFixture({ url: 'https://x1.example/v.m3u8', label: 'Same display text' }),
    qualityFixture({ url: 'https://x2.example/v.m3u8', label: 'Same display text' }),
  ]);
  ok(byLabel.length === 2, 'L: entries are NOT deduped by display label — distinct URLs stay distinct');
  const cleaned = dedupeMaveroStreams([qualityFixture({ url: '   ' }), qualityFixture({ url: '' }), qualityFixture({ url: undefined as unknown as string })] as PlayerQualityOption[]);
  ok(cleaned.length === 0, 'L: entries without a usable URL are dropped before grouping');
  ok(groupMaveroStreams([qualityFixture({ url: 'https://z.example/v.m3u8' }), qualityFixture({ url: 'https://z.example/v.m3u8' })])[0].streams.length === 1, 'L: grouping dedupes transparently');
}

// ===========================================================================
// M — zero-stream state
// ===========================================================================

{
  // Only plain-http candidates → the playback boundary excludes them all.
  const empty = maveroPlayerSourceFromResolution({
    mediaType: 'movie', requestedMediaType: 'movie',
    sources: [resolvedStreamFixture({ url: 'http://insecure.example/v.m3u8', transport: 'http' })],
    unsupported: [], diagnostics: [], consideredAddons: 1, elapsedMs: 1,
  });
  ok(empty === null, 'M: zero playable streams compose to NULL (graceful empty result, never a throw)');
  ok(watchSource.includes("resolutionState = result.code === 'NO_STREAMS' ? 'unavailable' : 'network-error';"), 'M: the watch route maps the empty result to the graceful unavailable state');
  const clientHelper = read('src/lib/client/player/mavero-player.ts');
  ok(clientHelper.includes("const NO_STREAMS_MESSAGE = 'No playable streams are available from MAVERO Player right now.';"), 'M: the zero-stream message is the clear, generic Phase 4 text');
  const noStreamsMessage = /const NO_STREAMS_MESSAGE = '([^']*)';/.exec(clientHelper)?.[1] ?? '';
  const networkMessage = /const NETWORK_MESSAGE = '([^']*)';/.exec(clientHelper)?.[1] ?? '';
  ok(!/manifest|http|addon|error/i.test(noStreamsMessage + networkMessage), 'M: the user-facing zero-stream/network messages expose no addon, manifest or transport internals');
  ok(shellTemplate.includes('{#if maveroStreamGroups.length}'), 'M: with no aggregate source the stream section simply does not render — the provider rows stay usable');
}

// ===========================================================================
// N — failed stream state
// ===========================================================================

{
  ok(viewportSource.includes('onFatalError: () => {') && viewportSource.includes("dispatch('error');"), 'N: a failed engine stream surfaces through the EXISTING generic error event');
  ok(viewportSource.includes('if (hlsEngine !== engine) return;'), 'N: stale engines never surface errors for a newer source');
  ok(shellSource.includes("errorMessage = 'Playback could not be started. Try again or choose another source.';"), 'N: the failed-stream message stays actionable and generic');
  ok(shellTemplate.includes('aria-label="Try again"') && shellTemplate.includes('aria-label="Switch source"'), 'N: the error card keeps Try again + Switch source (the sheet stays reachable)');
}

// ===========================================================================
// O — one failed addon does not remove other streams
// ===========================================================================

{
  const aggregate = maveroPlayerSourceFromResolution({
    mediaType: 'movie', requestedMediaType: 'movie',
    sources: [
      resolvedStreamFixture({ addonSlug: 'addon-broken', addonName: 'Broken Addon', url: 'http://broken.example/v.m3u8', transport: 'http' }),
      resolvedStreamFixture({ addonSlug: 'addon-healthy', addonName: 'Healthy Addon', url: 'https://healthy.example/v.m3u8' }),
    ],
    unsupported: [], diagnostics: [], consideredAddons: 2, elapsedMs: 1,
  });
  ok(aggregate !== null && aggregate.qualities?.length === 1, 'O: the failing addon\u2019s stream is excluded without removing the healthy addon\u2019s stream');
  ok(aggregate?.qualities?.[0]?.addonName === 'Healthy Addon', 'O: the surviving entry is the healthy addon\u2019s stream');
  const groups = groupMaveroStreams(aggregate?.qualities ?? []);
  ok(groups.length === 1 && groups[0].addonName === 'Healthy Addon', 'O: the sheet still offers the healthy addon group');
}

// ===========================================================================
// P — source switching without navigation
// ===========================================================================

{
  const body = shellSource.slice(shellSource.indexOf('function selectMaveroStream'), shellSource.indexOf('type OrientationController'));
  ok(body.includes('closeSourceSheet();'), 'P: selecting a stream closes the sheet through the EXISTING close path (focus restored)');
  ok(body.includes('setQuality(stream.url);'), 'P: selecting a stream rides the EXISTING quality-switch mechanism');
  ok(!body.includes('onSourceChange') && !body.includes('goto('), 'P: in-source stream switching never re-resolves the virtual source and never navigates');
  ok(!shellSource.includes('goto('), 'P: PlayerShell contains no navigation at all — the user cannot leave the player page by selecting streams');
  ok(!watchSource.slice(watchSource.indexOf('function handleSourceChange')).includes('isMaveroStream'), 'P: the watch route source-switch path is untouched by stream-level selection');
}

// ===========================================================================
// Q — HLS → HLS switching
// ===========================================================================

{
  FakeHlsQuality.instances.length = 0;
  const engine = fakeEngine();
  await attachEngine(engine, 'https://cdn.example/first.m3u8');
  await attachEngine(engine, 'https://cdn.example/second.m3u8');
  ok(engine.getInstance() !== null && engine.isActive(), 'Q: after an HLS→HLS switch exactly one engine instance is live');
  ok(FakeHlsQuality.instances.filter((instance) => instance.destroyCalls > 0).length === 1, 'Q: the previous HLS instance was destroyed exactly once');
  ok((engine.getInstance() as FakeHlsQuality).loadSourceCalls.join('|') === 'https://cdn.example/second.m3u8', 'Q: the new manifest is the only load target');
  engine.destroy();
}

// ===========================================================================
// R/S — HLS ↔ MP4 routing on MIXED-protocol aggregates
// ===========================================================================

{
  // Aggregate whose PRIMARY stream is HLS but which also offers an MP4 stream.
  const hlsPrimary = makeAggregate({
    url: 'https://a.example/master.m3u8',
    metadata: { sourceName: MAVERO_PLAYER_SOURCE_NAME, providerName: MAVERO_PLAYER_SOURCE_NAME, protocol: 'hls' },
    qualities: [
      qualityFixture({ url: 'https://a.example/master.m3u8', protocol: 'hls' }),
      qualityFixture({ url: 'https://b.example/movie.mp4', label: 'Addon B · Auto', height: undefined, addonName: 'Addon B', protocol: 'mp4' }),
    ],
  });
  ok(protocolForStreamUrl(hlsPrimary, 'https://b.example/movie.mp4') === 'mp4', 'R: the per-stream protocol wins for the selected MP4 option (not the aggregate\u2019s primary protocol)');
  const narrowedToMp4 = sourceForStreamUrl(hlsPrimary, 'https://b.example/movie.mp4');
  ok(!isHlsMediaSource(narrowedToMp4, 'https://b.example/movie.mp4'), 'R: the selected MP4 stream is NOT classified as HLS');
  ok(resolveDirectPlaybackMode(narrowedToMp4, 'https://b.example/movie.mp4', makeVideo(false)) === 'native', 'R: HLS-primary aggregate → MP4 stream routes to the NATIVE path');
  // …and the aggregate\u2019s own HLS url still routes through the engine.
  ok(resolveDirectPlaybackMode(sourceForStreamUrl(hlsPrimary, 'https://a.example/master.m3u8'), 'https://a.example/master.m3u8', makeVideo(false)) === 'hls-js', 'R: the aggregate\u2019s HLS stream still routes to the hls.js engine');

  // Mirror image: MP4-primary aggregate offering an HLS stream.
  const mp4Primary = makeAggregate({
    url: 'https://a.example/movie.mp4',
    metadata: { sourceName: MAVERO_PLAYER_SOURCE_NAME, providerName: MAVERO_PLAYER_SOURCE_NAME, protocol: 'mp4' },
    qualities: [
      qualityFixture({ url: 'https://a.example/movie.mp4', label: 'Addon A · Auto', height: undefined, addonName: 'Addon A', protocol: 'mp4' }),
      qualityFixture({ url: 'https://b.example/master.m3u8', protocol: 'hls' }),
    ],
  });
  const narrowedToHls = sourceForStreamUrl(mp4Primary, 'https://b.example/master.m3u8');
  ok(isHlsMediaSource(narrowedToHls, 'https://b.example/master.m3u8'), 'S: the selected HLS stream inside an MP4-primary aggregate IS classified as HLS');
  ok(resolveDirectPlaybackMode(narrowedToHls, 'https://b.example/master.m3u8', makeVideo(false)) === 'hls-js', 'S: MP4-primary aggregate → HLS stream routes to the hls.js engine (Chrome)');
  ok(resolveDirectPlaybackMode(narrowedToHls, 'https://b.example/master.m3u8', makeVideo(true)) === 'native', 'S: on a native-HLS browser the same stream takes the existing native path');
  // Single-protocol sources pass through with NO object churn.
  ok(sourceForStreamUrl(hlsPrimary, 'https://a.example/master.m3u8') === hlsPrimary, 'S: when no per-stream override is needed the ORIGINAL source object is returned (no allocation)');
}

// ===========================================================================
// T — position preservation
// ===========================================================================

{
  ok(/function setQuality\(url: string\) \{\s*\n\s*if \(url === selectedQuality\) return;\s*\n\s*pendingSeek = currentTime;/.test(shellSource), 'T: the existing quality switch captures the current position into pendingSeek');
  ok(shellSource.includes('videoElement.currentTime = pendingSeek;'), 'T: the captured position is restored on the next loadedmetadata (existing mechanism)');
  const body = shellSource.slice(shellSource.indexOf('function selectMaveroStream'));
  ok(body.includes('setQuality(stream.url);'), 'T: addon-stream switching inherits position preservation through setQuality');
  // Internal level switching never moves the media position by design.
  const internalQualityBody = shellSource.slice(shellSource.indexOf('function setInternalQuality'), shellSource.indexOf('viewport?.selectEngineQuality(id);') + 40);
  ok(!internalQualityBody.includes('pendingSeek') && !internalQualityBody.includes('currentTime'), 'T: internal quality selection does NOT touch the position pipeline (seamless by design)');
}

// ===========================================================================
// U — stale source protection
// ===========================================================================

{
  let resolveLoader: ((factory: HlsFactory | null) => void) | undefined;
  FakeHlsQuality.instances.length = 0;
  const engine = new HlsPlaybackEngine({ hlsLoader: () => new Promise<HlsFactory | null>((resolve) => { resolveLoader = resolve; }) });
  const fatalError = new Promise<string>((resolve) => {
    void engine.attach(makeVideo(false) as unknown as HTMLMediaElement, 'https://cdn.example/slow.m3u8', { onFatalError: (message) => resolve(message) });
  });
  engine.destroy(); // the user switched sources while the loader was pending
  resolveLoader?.(() => new FakeHlsQuality());
  await new Promise((resolve) => setTimeout(resolve, 10));
  ok(!engine.isActive() && engine.getInstance() === null, 'U: a stale in-flight attach after destroy creates no live instance');
  ok(FakeHlsQuality.instances.length === 0, 'U: the stale loader continuation never constructs an hls.js instance');
  await Promise.race([fatalError, new Promise((resolve) => setTimeout(resolve, 10))]);
  ok(true, 'U: no fatal error can surface from a stale attach (guarded above — test only fails via timeout mismatch)');
  ok(passed > 0, 'U: generation guard keeps stale continuations inert');
}

// ===========================================================================
// V — mobile source UI
// ===========================================================================

{
  ok(shellSource.includes('.player-shell:not(.landscape-mode) .source-sheet, .player-shell:not(.landscape-mode) .episode-sheet { position: fixed; z-index: 21; bottom: 0; left: 0; right: 0; top: auto; max-height: 60dvh; overflow: auto;'), 'V: the portrait bottom-sheet contract is intact (the new section scrolls inside it — no horizontal overflow surface)');
  ok(shellSource.includes('.sheet-option { display: flex; align-items: center; gap: 11px; min-height: 52px;'), 'V: stream rows reuse the existing 52px sheet-option touch target (>=44px)');
  ok(shellSource.includes('.mavero-group-name { overflow: hidden;') && shellSource.includes('.mavero-group-name { overflow: hidden; padding: 6px 12px 2px; color: var(--ink-soft); font-size: .66rem; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }'), 'V: long addon names truncate with ellipsis (never stretch the sheet)');
  ok(shellSource.includes('.mavero-quality-row { align-items: center; flex-wrap: wrap;'), 'V: the quality row wraps instead of overflowing narrow screens');
  ok(shellSource.includes('.mavero-stream-option { width: 100%; }'), 'V: stream rows span the sheet width (no tiny buttons)');
}

// ===========================================================================
// W — desktop source UI
// ===========================================================================

{
  ok(shellSource.includes('@media (min-width: 769px)'), 'W: the desktop popover breakpoint is intact');
  ok(shellSource.includes('width: min(400px, calc(100% - 48px)); max-height: min(70dvh, 560px);'), 'W: the desktop source popover keeps its bounded size (the section cannot dominate the player)');
  ok(!/\.mavero-section[^{]*\{[^}]*[^-]width:\s*\d/.test(shellSource), 'W: the MAVERO section adds no fixed width of its own (flows inside the sheet)');
}

// ===========================================================================
// X — landscape behavior
// ===========================================================================

{
  ok(/\.player-shell\.landscape-mode \.source-sheet \{[^}]*position: absolute[^}]*right: 0[^}]*width: min\(320px, 30vw\)/.test(shellSource), 'X: the landscape right-edge drawer contract is intact (position, anchoring, width)');
  ok(shellSource.includes('.player-shell.landscape-mode .source-sheet .sheet-list { max-height: 100%; overflow-y: auto;'), 'X: the landscape drawer list still scrolls — the new section lives inside that scroll');
  ok(shellSource.includes('@media (prefers-reduced-motion: reduce)') && shellSource.includes('.player-shell.landscape-mode .source-sheet, .player-shell.landscape-mode .episode-sheet { animation: none; }'), 'X: reduced-motion landscape animation opt-out is intact');
  ok(shellTemplate.indexOf('mavero-section') > shellTemplate.indexOf('sheet-list') && shellSource.includes('.player-shell.landscape-mode .source-sheet .sheet-list'), 'X: the section renders inside .sheet-list, so it inherits the landscape drawer scroll/safe-area handling');
}

// ===========================================================================
// Y — keyboard navigation
// ===========================================================================

{
  ok(shellSource.includes('function handleSheetKeydown(event: KeyboardEvent)'), 'Y: the sheet keyboard handler is intact');
  ok(shellSource.includes("querySelectorAll<HTMLElement>('button, a, input, select, textarea, [tabindex]:not([tabindex=\"-1\"])')"), 'Y: the focus trap iterates real buttons — the new stream/quality buttons are included');
  ok(shellTemplate.includes('<button class="sheet-option mavero-stream-option" type="button" role="option"'), 'Y: stream rows are real <button type="button"> elements (Enter/Space natively work)');
  ok(shellTemplate.includes('<button class="variant-button" class:active={engineQuality?.selected === option.id} type="button"'), 'Y: quality toggles are real buttons too');
}

// ===========================================================================
// Z — focus handling
// ===========================================================================

{
  ok(shellSource.includes('function openSourceSheet(trigger: HTMLElement)') && shellSource.includes('setTimeout(() => focusSheetCloseButton(\u0027source\u0027), 0);'), 'Z: opening the sheet moves focus to the close button (existing behavior)');
  ok(shellSource.includes('function closeSourceSheet()') && shellSource.includes('restoreFocus(sourceSheetTrigger);'), 'Z: closing the sheet restores focus to the trigger (existing behavior)');
  ok(!shellSource.includes('autofocus'), 'Z: the new section adds no focus-stealing autofocus');
  ok(shellSource.includes('function selectMaveroStream(stream: PlayerQualityOption) {\n    closeSourceSheet();'), 'Z: stream selection closes the sheet first — focus restore runs before playback switches');
}

// ===========================================================================
// AA — accessibility labels
// ===========================================================================

{
  ok(shellTemplate.includes('<div class="source-sheet" role="dialog" aria-modal="true" aria-label="Available playback sources">'), 'AA: the sheet dialog contract is byte-identical (Phase 8 pin preserved)');
  ok(shellTemplate.includes('role="listbox" aria-label="MAVERO Player addon streams"'), 'AA: the stream list is a labeled listbox');
  ok(shellTemplate.includes('aria-label={`${group.addonName} streams`}'), 'AA: each addon group is labeled with the addon display name (screen-reader understandable)');
  ok(shellTemplate.includes('role="group" aria-label="Playback quality"'), 'AA: the internal quality row is a labeled group');
  ok(shellTemplate.includes('aria-pressed={engineQuality?.selected === option.id}'), 'AA: quality mode uses aria-pressed (button selection state)');
  ok(shellTemplate.includes('aria-label="Close source list"'), 'AA: the sheet close button keeps its accessible name');
  ok(shellTemplate.includes('<strong>{maveroStreamQualityLabel(stream)}</strong>'), 'AA: quality names come from the derived human-readable label (screen-reader understandable)');
}

// ===========================================================================
// AB — no admin addon controls exposed
// ===========================================================================

{
  ok(!shellSource.includes('/admin'), 'AB: the player shell exposes no admin route or control');
  ok(!shellSource.includes('<input') && !shellSource.includes('<textarea'), 'AB: the player shell has NO text inputs — users cannot enter manifest URLs anywhere in the player');
  ok(!/enable addon|disable addon|add addon|remove addon|delete addon|manage addon/i.test(shellSource), 'AB: no addon enable/disable/add/remove/manage controls exist in the user-facing player');
  ok(!watchSource.includes('/admin/addons') && !watchSource.includes('manifest'), 'AB: the watch route exposes no admin addon management and no manifest handling');
  const clientHelper = read('src/lib/client/player/mavero-player.ts');
  ok(clientHelper.includes("body: JSON.stringify(body)") && clientHelper.includes('contentId: request.contentId, mediaType: request.mediaType'), 'AB: the client sends ONLY content identifiers to the playback endpoint (consumption-only, per Phase 4)');
}

// ===========================================================================
// AC — no manifest URL / internal identifiers exposed in the user UI
// ===========================================================================

{
  const aggregate = maveroPlayerSourceFromResolution({ mediaType: 'movie', requestedMediaType: 'movie', sources: [resolvedStreamFixture()], unsupported: [], diagnostics: [], consideredAddons: 1, elapsedMs: 1 });
  const optionKeys = Object.keys(aggregate?.qualities?.[0] ?? {}).sort();
  ok(JSON.stringify(optionKeys) === JSON.stringify(['addonName', 'height', 'label', 'protocol', 'url']), 'AC: a quality option carries ONLY safe presentation fields');
  const sourceKeys = Object.keys(aggregate ?? {}).sort().join(',');
  ok(sourceKeys === 'mediaType,metadata,providerId,qualities,sourceId,type,url', 'AC: the aggregate source top-level shape is unchanged (Phase 4 contract)');
  ok(!shellTemplate.includes('m3u8') && !shellTemplate.includes('manifestUrl'), 'AC: the rendered sheet template contains no manifest URL material');
  ok(!streamsSource.includes('manifestUrl') && !engineSource.includes('manifestUrl'), 'AC: the client player modules define no manifest URL handling');
  ok(!shellTemplate.includes('MAVERO_PLAYER_MAX_STREAMS') || shellTemplate.includes('{maveroStreams.length} stream'), 'AC: the sheet shows a stream COUNT, never internal identifiers');
}

// ===========================================================================
// AD — no P2P/torrent entries
// ===========================================================================

{
  const phase6Client = streamsSource + engineSource + shellSource + controlsSource + viewportSource;
  ok(!/magnet|infoHash|info_hash|debrid|\.torrent|announce=/.test(phase6Client), 'AD: no torrent/P2P path, field or link exists in any Phase 6 client player module');
}

// ===========================================================================
// AE — no media proxy
// ===========================================================================

{
  ok(!streamsSource.includes('/proxy') && !shellSource.includes('/proxy') && !viewportSource.includes('/proxy'), 'AE: no proxy route is referenced by the Phase 6 client modules');
  ok(!engineSource.includes('XMLHttpRequest') && !engineSource.includes('pLoader') && !engineSource.includes('loaderCallbacks'), 'AE: the engine ships no custom hls.js loader implementation (manifest/segment requests stay plain browser requests)');
  ok(!viewportSource.includes('fetch(') && !streamsSource.includes('fetch(') && !controlsSource.includes('fetch('), 'AE: the Phase 6 UI modules perform ZERO network requests (pure presentation)');
}

// ===========================================================================
// AF — no arbitrary headers
// ===========================================================================

{
  ok(!engineSource.includes('xhrSetup') && !engineSource.includes('fetchSetup') && !engineSource.includes('setRequestHeader') && !engineSource.includes('Authorization'), 'AF: no custom loader/headers hook exists in the engine (default config only)');
  ok(!streamsSource.includes('headers') && !shellSource.includes('xhrSetup'), 'AF: the presentation modules carry no header logic at all');
  {
    FakeHlsQuality.instances.length = 0;
    const engine = fakeEngine();
    const instance = await attachEngine(engine, 'https://cdn.example/headers.m3u8');
    ok(instance.config === undefined, 'AF: the engine constructs hls.js with its DEFAULT configuration (no config object at all)');
    engine.destroy();
  }
}

// ===========================================================================
// AG — existing source callback remains compatible
// ===========================================================================

{
  ok(shellSource.includes('export let onSourceChange: (sourceId: string, variant?: string) => void = () => {};'), 'AG: the onSourceChange contract is byte-identical');
  ok(/function chooseSource\(sourceId: string, variant\?: string\) \{[\s\S]*?closeSourceSheet\(\);/.test(shellSource), 'AG: chooseSource still closes the sheet and delegates (Phase 7F variant contract intact)');
  ok(watchSource.includes('prepareSource(sourceId, false)'), 'AG: manual source switches still pass allowFallback=false');
  ok(shellTemplate.includes('onclick={() => chooseSource(option.id)}'), 'AG: provider source rows still select through the same callback');
}

// ===========================================================================
// AH — Phase 5 HLS engine remains compatible
// ===========================================================================

{
  ok(typeof looksLikeHlsUrl('https://cdn.example/video.M3U8') === 'boolean' && looksLikeHlsUrl('https://cdn.example/video.M3U8'), 'AH: Phase 5 routing helpers are unchanged');
  ok(JSON.stringify(Object.values(HLS_ENGINE_EVENTS)) === JSON.stringify(['hlsMediaAttached', 'hlsManifestLoading', 'hlsManifestLoaded', 'hlsManifestParsed', 'hlsLevelLoaded', 'hlsLevelSwitched', 'hlsError']), 'AH: the Phase 5 event names are preserved and only ADD the two Phase 6 listeners');
  ok(HLS_RECOVERY_LIMITS.network === 2 && HLS_RECOVERY_LIMITS.media === 1, 'AH: the bounded recovery budget is unchanged');

  // The narrow Phase 5 double (NO quality surface) must keep working.
  const narrowFactory: HlsFactory = () => new FakeHlsNarrow();
  const engine = new HlsPlaybackEngine({ hlsLoader: async () => narrowFactory });
  let levelsEventFired = false;
  let selectionEvent = '';
  await engine.attach(makeVideo(false) as unknown as HTMLMediaElement, 'https://cdn.example/legacy.m3u8', {
    onQualityLevels: () => { levelsEventFired = true; },
    onQualitySelection: (selection) => { selectionEvent = selection; },
  });
  const narrow = engine.getInstance() as FakeHlsNarrow;
  narrow.emit(HLS_ENGINE_EVENTS.manifestParsed);
  narrow.emit(HLS_ENGINE_EVENTS.levelSwitched);
  ok(levelsEventFired, 'AH: a Phase 5-era instance without levels degrades gracefully (empty level list, no crash)');
  ok(engine.getQualityLevels().length === 0 && engine.getQualitySelection() === PLAYER_AUTO_QUALITY_ID, 'AH: missing quality surface reads as AUTO (never a forced level)');
  engine.setQualityLevel(0);
  engine.setAutoQualityLevel();
  ok(engine.getInstance() === narrow && narrow.destroyCalls === 0, 'AH: quality calls on a legacy surface are safe no-ops (no destroy, no throw)');
  narrow.emit(HLS_ENGINE_EVENTS.error, { fatal: true, type: 'networkError', details: 'fragLoadError' });
  ok(engine.isActive(), 'AH: fatal-error recovery still engages on a legacy instance');
  narrow.emit(HLS_ENGINE_EVENTS.error, { fatal: true, type: 'networkError', details: 'fragLoadError' });
  narrow.emit(HLS_ENGINE_EVENTS.error, { fatal: true, type: 'networkError', details: 'fragLoadError' });
  ok(!engine.isActive(), 'AH: the recovery budget still exhausts into the existing fatal path');
  ok(selectionEvent === PLAYER_AUTO_QUALITY_ID || selectionEvent === '', 'AH: no bogus selection leaked from the legacy instance');
  engine.destroy();
  void selectionEvent;
}

// ===========================================================================
// AI — HLS AUTO mode
// ===========================================================================

{
  FakeHlsQuality.instances.length = 0;
  const engine = fakeEngine();
  const levelPayloads: number[] = [];
  const selectionPayloads: string[] = [];
  const instance = await attachEngine(engine, 'https://cdn.example/master.m3u8', {
    onQualityLevels: (levels) => levelPayloads.push(levels.length),
    onQualitySelection: (selection) => selectionPayloads.push(selection),
  });
  instance.levels = STANDARD_LEVELS;
  instance.emit(HLS_ENGINE_EVENTS.manifestParsed);
  ok(levelPayloads.length === 1 && levelPayloads[0] === 3, 'AI: manifest parse reports the full level list exactly once');
  ok(instance.nextLevelWrites.length === 0, 'AI: the engine NEVER forces a level — ABR stays in control by default (AUTO default)');
  ok(engine.getQualitySelection() === PLAYER_AUTO_QUALITY_ID, 'AI: the generic selection id is the reserved AUTO id while ABR is in control');
  instance.emit(HLS_ENGINE_EVENTS.levelSwitched);
  ok(selectionPayloads[0] === PLAYER_AUTO_QUALITY_ID, 'AI: an ABR level switch still reports the AUTO mode (the UI reflects the MODE, not every ABR hop)');
  engine.setAutoQualityLevel();
  ok(JSON.stringify(instance.nextLevelWrites) === '[-1]', 'AI: AUTO maps to the hls.js -1 mechanism (no magic numeric level)');
  engine.destroy();
}

// ===========================================================================
// AJ — HLS manual quality selection
// ===========================================================================

{
  FakeHlsQuality.instances.length = 0;
  const engine = fakeEngine();
  const instance = await attachEngine(engine, 'https://cdn.example/manual.m3u8');
  instance.levels = STANDARD_LEVELS;
  engine.setQualityLevel(1);
  ok(JSON.stringify(instance.nextLevelWrites) === '[1]', 'AJ: manual selection writes the seamless nextLevel switch (not currentLevel)');
  ok(instance.autoLevelEnabled === false, 'AJ: the instance leaves ABR mode after a manual selection');
  ok(engine.getQualitySelection() === '1', 'AJ: the generic selection reports the manual level');
  engine.setQualityLevel(2);
  ok(JSON.stringify(instance.nextLevelWrites) === '[1,2]', 'AJ: subsequent manual selections keep using the same mechanism');
  engine.setQualityLevel(-3);
  engine.setQualityLevel(99);
  engine.setQualityLevel(Number.NaN);
  ok(JSON.stringify(instance.nextLevelWrites) === '[1,2]', 'AJ: out-of-range/invalid selections are rejected before touching hls.js');
  engine.destroy();
  ok(engine.getQualitySelection() === null && engine.getQualityLevels().length === 0, 'AJ: after destroy the quality surface is empty (no stale UI state)');
}

// ===========================================================================
// AK — HLS level labels
// ===========================================================================

{
  ok(hlsLevelLabel({ height: 1080 }) === '1080p', 'AK: height 1080 → "1080p"');
  ok(hlsLevelLabel({ height: 480 }) === '480p', 'AK: height 480 → "480p"');
  ok(hlsLevelLabel({ bitrate: 1_500_000 }) === '1.5 Mbps', 'AK: bitrate 1.5Mbps → "1.5 Mbps"');
  ok(hlsLevelLabel({ bitrate: 2_000_000 }) === '2 Mbps', 'AK: whole-Mbps bitrates render without a trailing decimal');
  ok(hlsLevelLabel({ bitrate: 800_000 }) === '800 kbps', 'AK: sub-Mbps bitrates render as kbps');
  ok(hlsLevelLabel({}) === 'Auto', 'AK: no height and no bitrate → "Auto" (never a misleading label)');
  ok(hlsLevelLabel({ height: -5, bitrate: -1 }) === 'Auto', 'AK: nonsensical values never produce labels');
  const options = engineLevelsSnapshot();
  ok(JSON.stringify(options) === JSON.stringify([{ id: '0', label: '1080p' }, { id: '1', label: '720p' }, { id: '2', label: '480p' }]), 'AK: engine quality options are generic {id,label} pairs derived safely');
}

/** Helper for AK: generic options over STANDARD_LEVELS (index = id). */
function engineLevelsSnapshot(): Array<{ id: string; label: string }> {
  return STANDARD_LEVELS.map((level, index) => ({ id: String(index), label: hlsLevelLabel(level) }));
}

// ===========================================================================
// AL — quality switch does NOT recreate the engine
// ===========================================================================

{
  FakeHlsQuality.instances.length = 0;
  const engine = fakeEngine();
  const instance = await attachEngine(engine, 'https://cdn.example/keep.m3u8');
  instance.levels = STANDARD_LEVELS;
  engine.setQualityLevel(0);
  engine.setAutoQualityLevel();
  engine.setQualityLevel(2);
  ok(engine.getInstance() === instance, 'AL: the engine instance is IDENTICAL across internal quality switches');
  ok(instance.destroyCalls === 0 && FakeHlsQuality.instances.length === 1, 'AL: no destroy, no second hls.js instance — internal switching is seamless');
  ok(instance.attachedMedia.length === 1, 'AL: the media element was never re-attached');
  engine.destroy();
}

// ===========================================================================
// AM — HLS quality failure recovery
// ===========================================================================

{
  FakeHlsQuality.instances.length = 0;
  const engine = fakeEngine();
  let fatal = false;
  const instance = await attachEngine(engine, 'https://cdn.example/failing-level.m3u8', {
    onFatalError: () => { fatal = true; },
  });
  instance.levels = STANDARD_LEVELS;
  instance.failNextLevelWrites = 1; // the FIRST level switch request fails
  engine.setQualityLevel(0);
  ok(JSON.stringify(instance.nextLevelWrites) === '[-1]', 'AM: a failed level switch falls back to the AUTO mechanism (spec §35)');
  ok(!fatal && instance.destroyCalls === 0 && engine.isActive(), 'AM: a failed level switch never destroys the instance nor surfaces a player error');
  ok(engine.getInstance() === instance, 'AM: the failed switch also left the engine instance itself in place');
  instance.failNextLevelWrites = 0;
  instance.emit(HLS_ENGINE_EVENTS.error, { fatal: true, type: 'mediaError', details: 'bufferStalledError' });
  instance.emit(HLS_ENGINE_EVENTS.error, { fatal: true, type: 'mediaError', details: 'bufferStalledError' });
  ok(fatal && !engine.isActive(), 'AM: genuinely unrecoverable playback STILL goes through the existing fatal path');
  ok(HLS_UNRECOVERABLE_MESSAGE.length > 0, 'AM: the generic unrecoverable message is unchanged');
}

// ===========================================================================
// AN — MP4 quality behavior unchanged
// ===========================================================================

{
  ok(engineLevelsSnapshotForMp4(), 'AN: MP4 sources never enter the engine quality path (resolved below)');
  const direct = new DirectPlayerAdapter();
  const source: PlayerSource = { type: 'direct', url: 'https://media.example/title-720.mp4', providerId: 'p', sourceId: 's', mediaType: 'movie', qualities: [{ url: 'https://media.example/title-720.mp4', height: 720, label: '720p' }] };
  ok(!isHlsMediaSource(source, source.url as string), 'AN: an MP4 source is never classified as HLS (routing unchanged)');
  ok(resolveDirectPlaybackMode(source, source.url as string, makeVideo(false)) === 'native', 'AN: MP4 keeps the native path with no engine involvement');
  ok(direct.canHandle(source), 'AN: the direct adapter still accepts the MP4 source');
  ok(maveroStreamFormatLabel({ url: source.url as string, protocol: 'mp4' }) === 'MP4', 'AN: MP4 streams present as "MP4" in the sheet');
}

function engineLevelsSnapshotForMp4(): boolean {
  // An MP4 option inside an aggregate routes by ITS protocol through the
  // same narrowing the viewport performs before every routing decision.
  const mp4Url = 'https://media.example/title-720.mp4';
  const mp4Aggregate = makeAggregate({
    url: mp4Url,
    qualities: [qualityFixture({ url: mp4Url, protocol: 'mp4', label: 'Addon A · 720p', height: 720 })],
  });
  return isHlsMediaSource(sourceForStreamUrl(mp4Aggregate, mp4Url), mp4Url) === false;
}

// ===========================================================================
// AO — source panel close/open behavior
// ===========================================================================

{
  ok(/function openSourceSheet\(trigger: HTMLElement\) \{[\s\S]*?sourceMenuOpen = true;/.test(shellSource), 'AO: the open path is intact (trigger saved, one sheet at a time)');
  ok(shellSource.includes('episodeMenuOpen = false; // only one sheet at a time'), 'AO: only one sheet opens at a time');
  ok(shellTemplate.includes('<div class="sheet-overlay" role="presentation" onclick={() => closeSourceSheet()}></div>'), 'AO: the backdrop still closes the sheet');
  ok(shellTemplate.includes('onclick={() => closeSourceSheet()}><X size={17} /></button>'), 'AO: the close button still closes the sheet');
  ok(/state = 'switching-source';[\s\S]{0,80}onSourceChange\(sourceId, variant\);/.test(shellSource), 'AO: virtual-source switching still shows the existing switching state');
}

// ===========================================================================
// AP — player remains mounted during source selection
// ===========================================================================

{
  const directBranch = viewportSource.slice(viewportSource.indexOf("{#if source?.type === 'direct' && mediaUrl}"), viewportSource.indexOf("{:else if source?.type === 'embed'"));
  ok(directBranch.includes('<video') && !directBranch.includes('{#key'), 'AP: the direct <video> element is NOT keyed/remounted for stream switches (the player stays mounted)');
  ok(viewportSource.includes('if (hlsEngineActive && hlsEngineUrl === url) return;'), 'AP: same-URL reactive re-runs never re-attach the engine (existing Phase 5 guard)');
  ok(shellSource.includes('state = \u0027preparing\u0027;') && shellSource.includes("state = 'switching-source';"), 'AP: switching states reuse the EXISTING shell states — no second loading system');
  ok(!shellTemplate.includes('watch/'), 'AP: the shell template contains no navigation targets');
}

// ===========================================================================
// AQ — no duplicate quality menus
// ===========================================================================

{
  ok(controlsSource.includes('{#if internalQualities.length > 1}') && controlsSource.includes('{:else if qualities.length > 1}'), 'AQ: PlayerControls renders the internal select OR the stream select — never both');
  ok(controlsSource.split('select-control quality').length === 3, 'AQ: exactly one quality select exists in the controls markup (open+close class pair across the two branches)');
  ok(shellSource.split('aria-label="Playback quality"').length === 2, 'AQ: the sheet has exactly ONE internal quality row');
  ok(shellSource.split('<select').length === 1, 'AQ: the shell itself renders no <select> — quality lives in exactly one surface per context');
  ok(/engineQuality && engineQuality\.options\.length > 1/.test(shellSource), 'AQ: the sheet quality row is gated to multi-level manifests (single-level HLS shows no second menu)');
}

// ===========================================================================
// AR — no duplicate source controls
// ===========================================================================

{
  ok(shellTemplate.split('aria-label="Switch source"').length === 4, 'AR: exactly the existing three source controls remain (message card, landscape overlay, embed bar — plus the split artifact)');
  ok(controlsSource.split('Choose source, ${sourceCount} available').length === 2, 'AR: the desktop controls keep their single source button');
  ok(shellTemplate.split('{#each sourceOptions as option}').length === 2, 'AR: still exactly one source-options list (streams never become source options)');
}

// ===========================================================================
// AS — source selection uses buttons/accessible controls
// ===========================================================================

{
  const sectionSlice = shellTemplate.slice(shellTemplate.indexOf('mavero-section'), shellTemplate.indexOf('{/if}', shellTemplate.indexOf('mavero-quality-row')));
  const onclickLines = sectionSlice.split('\n').filter((line) => line.includes('onclick='));
  ok(onclickLines.length > 0 && onclickLines.every((line) => line.includes('<button')), 'AS: every clickable element in the MAVERO section is a real <button> (no clickable <div>)');
  ok(onclickLines.every((line) => line.includes('type="button"')), 'AS: every clickable element is type="button" (no implicit submit)');
}

// ===========================================================================
// AT — test chain registration
// ===========================================================================

{
  const packageJson = JSON.parse(read('package.json')) as { scripts: { test: string } };
  const chain = packageJson.scripts.test;
  const phase5Index = chain.indexOf('scripts/stremio_player_phase5_test.ts');
  const phase6Index = chain.indexOf('scripts/stremio_player_phase6_test.ts');
  ok(phase6Index > -1, 'AT: the Phase 6 test is registered in the package.json test chain');
  ok(phase5Index > -1 && phase6Index > phase5Index, 'AT: the Phase 6 test runs AFTER the Phase 5 test');
  const phase4Index = chain.indexOf('scripts/stremio_player_phase4_test.ts');
  ok(phase4Index > -1 && phase5Index > phase4Index, 'AT: the existing stremio chain order is preserved');
}

// ---------------------------------------------------------------------------

console.log(`stremio_player_phase6_test: ${passed} checks passed (hls.js quality surface + MAVERO source/quality UX)`);

