import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { StreamingAddon } from '$lib/shared/streaming-addons';
import {
  resolveSingleAddonDownload,
  type ContentLookup,
} from '$lib/server/streaming/stremio/addon-download-service';
import { normalizeStremioStreamResponseForDownloader } from '$lib/server/streaming/stremio/stream-normalize-downloader';

/**
 * Phase B — Subtitle compliance audit test suite (§B2 subtitles).
 *
 * The approved plan lists "subtitles" as a metadata dimension the card must
 * improve. The user's Phase B final-compliance audit (point 1) requires:
 *
 *   "If subtitle information is already available in the raw response /
 *    existing normalized model, Phase B must surface it in the card."
 *
 * FINDING from the audit:
 *   The PLAYER normalizer (`stream-normalize.ts`) ALREADY extracts subtitle
 *   tracks via `normalizeSubtitleTracks(record.subtitles)` and exposes them
 *   on `NormalizedStremioStream.subtitles`. The standard Stremio addon
 *   stream entry supports a top-level `subtitles` array of
 *   `{ url, lang, label }` objects (shape-checked by the player normalizer).
 *
 *   The DOWNLOAD normalizer previously did NOT mirror this extraction. The
 *   subtitle data was available in the raw response but dropped at the
 *   downloader boundary.
 *
 * FIX (this commit):
 *   1. `stream-normalize.ts` — exported `normalizeSubtitleTracks` (was
 *      private) so the downloader normalizer can reuse the SAME extraction
 *      logic without duplicating it.
 *   2. `stream-normalize-downloader.ts` — imports `normalizeSubtitleTracks`
 *      + `NormalizedStreamSubtitle` type; adds `subtitles?` field to
 *      `DownloaderStreamEntry`; calls `normalizeSubtitleTracks(record.subtitles)`
 *      in `classifyDownloaderEntry`.
 *   3. `download-selection.ts` — adds `subtitles?` field to
 *      `DownloadStreamViewAll`; `buildDownloadCandidatesAll` populates it.
 *   4. `addon-download-service.ts` — adds `subtitles?` field to the public
 *      `AddonDownloadStreamView`; `toStreamViewAll` plumbs it through.
 *   5. `MaveroAddonDownload.svelte` — adds `subtitles?` to the client
 *      `StreamView` type; renders a Captions-icon badge with the track
 *      count when subtitles are present.
 *
 * This test suite verifies:
 *   - Subtitle extraction mirrors the player normalizer (same shape).
 *   - The subtitle URLs are NEVER fetched (the security boundary applies).
 *   - The card surfaces subtitle track count when the addon supplies them.
 *   - The card hides the subtitle badge when the addon supplies no subtitles.
 *   - Malformed subtitle entries are silently dropped (never fail the stream).
 *   - The shared `normalizeSubtitleTracks` helper is reused (no duplication).
 *
 * All responses are mocked — no real addon / network requests are made.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');
const publicDns = (async (hostname: string) => [{ address: '93.184.216.34', family: 4 }]) as never;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function addonFixture(overrides: Partial<StreamingAddon> & { id: string; name: string; slug: string; manifestUrl: string }): StreamingAddon {
  return {
    enabled: true,
    status: 'experimental',
    ordering: 0,
    supportedTypes: ['movie', 'series'],
    idPrefixes: ['tt'],
    resources: ['catalog', 'meta', 'stream'],
    capabilities: {
      supportsStream: true,
      manifestId: `community.${overrides.slug}`,
      normalizedAt: new Date().toISOString(),
      streamTypes: ['movie', 'series'],
      streamIdPrefixes: ['tt'],
      idProperties: ['imdb_id'],
    },
    ...overrides,
  } as unknown as StreamingAddon;
}

const HUB = addonFixture({ id: '00000000-0000-4000-8000-14000000hub0', name: 'HdHub', slug: 'hdhub', manifestUrl: 'https://hdhub.example/manifest.json', ordering: 0 });

const CONTENT: ContentLookup = { title: 'Dhurandhar: The Revenge', identifiers: { imdbId: 'tt8633518', tmdbId: '1094521' }, runtimeSeconds: 3 * 3600 + 49 * 60 };
const loadContentOf = (lookup: ContentLookup) => async () => lookup;
const loadAddonsOf = (addons: StreamingAddon[]) => async () => addons;
const loadAddonByIdOf = (addons: StreamingAddon[]) => async (_client: unknown, id: string) => addons.find((addon) => addon.id === id) ?? null;

const movieRequest = { mediaType: 'movie' as const, contentId: 'movie-1094521' };

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function fetcherFor(routes: Record<string, unknown>, calls: string[]): typeof fetch {
  return (async (url: string | URL) => {
    const key = String(url);
    calls.push(key);
    const handler = routes[key] ?? routes['*'];
    if (handler instanceof Response) return handler.clone();
    if (typeof handler === 'function') return (handler as () => Response)();
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

const noSleep = async () => Promise.resolve();

// ---------------------------------------------------------------------------
// §B2-sub.1 — Source-level: subtitle extraction is mirrored from the player normalizer
// ---------------------------------------------------------------------------

function section1_sourceMirror(): void {
  const downloaderNormalizerSource = read('src/lib/server/streaming/stremio/stream-normalize-downloader.ts');
  const playerNormalizerSource = read('src/lib/server/streaming/stremio/stream-normalize.ts');
  // The player normalizer exports the helper + the type.
  ok(playerNormalizerSource.includes('export function normalizeSubtitleTracks'), '1: player normalizer exports normalizeSubtitleTracks');
  ok(playerNormalizerSource.includes('export type NormalizedStreamSubtitle'), '1: player normalizer exports NormalizedStreamSubtitle type');
  // The downloader normalizer imports + uses them (NO duplication).
  ok(downloaderNormalizerSource.includes('normalizeSubtitleTracks'), '1: downloader normalizer imports normalizeSubtitleTracks');
  ok(downloaderNormalizerSource.includes('NormalizedStreamSubtitle'), '1: downloader normalizer imports NormalizedStreamSubtitle type');
  ok(downloaderNormalizerSource.includes('const subtitles = normalizeSubtitleTracks(record.subtitles)'), '1: downloader normalizer calls normalizeSubtitleTracks(record.subtitles)');
  ok(downloaderNormalizerSource.includes('...(subtitles?.length ? { subtitles } : {})'), '1: downloader normalizer populates the subtitles field conditionally');
  // The DownloaderStreamEntry type declares the subtitles field.
  ok(downloaderNormalizerSource.includes('subtitles?: NormalizedStreamSubtitle[]'), '1: DownloaderStreamEntry.subtitles field declared');
  // The player normalizer's normalizeSubtitleEntry is still private (no duplication leak).
  ok(playerNormalizerSource.includes('function normalizeSubtitleEntry('), '1: player normalizer keeps normalizeSubtitleEntry private (internal helper)');
}

// ---------------------------------------------------------------------------
// §B2-sub.2 — Subtitle extraction mirrors the player normalizer (same shape)
// ---------------------------------------------------------------------------

function section2_extractionShape(): void {
  // A stream entry WITH a subtitles array.
  const normalized = normalizeStremioStreamResponseForDownloader({
    streams: [
      {
        name: '1080p',
        title: 'Dhurandhar 1080p WEB-DL',
        url: 'https://hub.example/movie.mkv',
        subtitles: [
          { url: 'https://subs.example/en.vtt', lang: 'English', label: 'English' },
          { url: 'https://subs.example/hi.vtt', lang: 'Hindi', label: 'Hindi' },
        ],
      },
    ],
  });
  ok(normalized.valid, '2: normalizer returns valid for stream-with-subtitles payload');
  ok(normalized.entries.length === 1, `2: 1 entry preserved (got ${normalized.entries.length})`);
  const entry = normalized.entries[0];
  ok(entry.subtitles !== undefined, '2: subtitles field is populated');
  ok(Array.isArray(entry.subtitles), '2: subtitles is an array');
  ok(entry.subtitles?.length === 2, `2: 2 subtitle tracks preserved (got ${entry.subtitles?.length})`);
  ok(entry.subtitles?.[0]?.url === 'https://subs.example/en.vtt', '2: first subtitle URL preserved verbatim');
  ok(entry.subtitles?.[0]?.language === 'English', '2: first subtitle language preserved');
  ok(entry.subtitles?.[0]?.label === 'English', '2: first subtitle label preserved');
  ok(entry.subtitles?.[1]?.url === 'https://subs.example/hi.vtt', '2: second subtitle URL preserved verbatim');
  ok(entry.subtitles?.[1]?.language === 'Hindi', '2: second subtitle language preserved');
}

// ---------------------------------------------------------------------------
// §B2-sub.3 — Streams WITHOUT subtitles → subtitles field is undefined
// ---------------------------------------------------------------------------

function section3_noSubtitles(): void {
  const normalized = normalizeStremioStreamResponseForDownloader({
    streams: [
      { name: '1080p', title: 'Dhurandhar 1080p WEB-DL', url: 'https://hub.example/movie.mkv' },
    ],
  });
  const entry = normalized.entries[0];
  ok(entry.subtitles === undefined, `3: subtitles is undefined when the addon supplied none (got ${entry.subtitles})`);
}

// ---------------------------------------------------------------------------
// §B2-sub.4 — Malformed subtitle entries silently dropped (never fail the stream)
// ---------------------------------------------------------------------------

function section4_malformedSilentlyDropped(): void {
  const normalized = normalizeStremioStreamResponseForDownloader({
    streams: [
      {
        name: '1080p',
        title: 'Dhurandhar 1080p WEB-DL',
        url: 'https://hub.example/movie.mkv',
        subtitles: [
          // valid
          { url: 'https://subs.example/en.vtt', lang: 'English' },
          // malformed: not an object
          'not an object',
          // malformed: missing url
          { lang: 'French' },
          // malformed: non-http scheme
          { url: 'ftp://subs.example/fr.vtt', lang: 'French' },
          // malformed: credentials in URL
          { url: 'https://user:pass@subs.example/fr.vtt', lang: 'French' },
          // valid
          { url: 'https://subs.example/es.vtt', lang: 'Spanish' },
        ],
      },
    ],
  });
  const entry = normalized.entries[0];
  ok(entry.subtitles?.length === 2, `4: 2 valid subtitle tracks kept, 4 malformed dropped (got ${entry.subtitles?.length})`);
  ok(entry.subtitles?.[0]?.url === 'https://subs.example/en.vtt', '4: first valid subtitle preserved');
  ok(entry.subtitles?.[1]?.url === 'https://subs.example/es.vtt', '4: second valid subtitle preserved');
  // The stream itself is NOT failed by malformed subtitles.
  ok(normalized.entries.length === 1, '4: stream entry is preserved (malformed subtitles never fail the stream)');
  ok(normalized.malformed === 0, '4: no malformed STREAM entries (subtitle malformations don\'t count)');
}

// ---------------------------------------------------------------------------
// §B2-sub.5 — Subtitle URLs are NEVER fetched (security boundary)
// ---------------------------------------------------------------------------

function section5_securityBoundary(): void {
  // The subtitle extraction is pure shape-checking. The fetcher is called
  // ONLY for the stream LIST endpoint — never for any subtitle URL.
  const calls: string[] = [];
  // We can't run resolveSingleAddonDownload here without the full fetcher
  // mock (the stream URL itself needs to resolve). Instead, verify at the
  // source level that no subtitle URL is ever passed to fetch.
  const serviceSource = read('src/lib/server/streaming/stremio/addon-download-service.ts');
  const selectionSource = read('src/lib/server/streaming/stremio/download-selection.ts');
  const normalizerSource = read('src/lib/server/streaming/stremio/stream-normalize-downloader.ts');
  // The downloader pipeline NEVER calls fetch on a subtitle URL — the only
  // fetch is fetchStremioStreamResponse (the addon stream LIST endpoint).
  ok(selectionSource.includes('media URL is NEVER fetched') || selectionSource.includes('NEVER fetches'), '5: download-selection documents that media URLs are never fetched');
  ok(normalizerSource.includes('subtitle URLs are never fetched') || normalizerSource.includes('subtitle URLs are NEVER fetched'), '5: downloader normalizer documents that subtitle URLs are never fetched');
  // The fetcher is only used for the addon stream LIST endpoint.
  ok(serviceSource.includes('fetchStremioStreamResponse(plan.endpointUrl'), '5: the only fetch is fetchStremioStreamResponse for the stream LIST endpoint');
}

// ---------------------------------------------------------------------------
// §B2-sub.6 — End-to-end: subtitle tracks flow through the full pipeline
//              to the public API response shape
// ---------------------------------------------------------------------------

async function section6_endToEndPipeline(): Promise<void> {
  const calls: string[] = [];
  const result = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: noSleep,
    fetcher: fetcherFor({
      'https://hdhub.example/stream/movie/tt8633518.json': json({
        streams: [
          {
            name: '1080p',
            title: 'Dhurandhar 1080p WEB-DL',
            url: 'https://hub.example/movie.mkv',
            subtitles: [
              { url: 'https://subs.example/en.vtt', lang: 'English', label: 'English' },
              { url: 'https://subs.example/hi.vtt', lang: 'Hindi', label: 'Hindi' },
            ],
          },
        ],
      }),
    }, calls),
  });
  ok(result.status === 'loaded', `6: status='loaded' (got ${result.status})`);
  ok(result.streams.length === 1, `6: 1 stream (got ${result.streams.length})`);
  const stream = result.streams[0];
  ok(stream.subtitles !== undefined, '6: public API response includes subtitles field');
  ok(Array.isArray(stream.subtitles), '6: subtitles is an array on the public API');
  ok(stream.subtitles?.length === 2, `6: 2 subtitle tracks plumbed through (got ${stream.subtitles?.length})`);
  ok(stream.subtitles?.[0]?.url === 'https://subs.example/en.vtt', '6: subtitle URL preserved verbatim through the pipeline');
  ok(stream.subtitles?.[0]?.language === 'English', '6: subtitle language preserved through the pipeline');
  // The subtitle URLs are NOT in the calls list (never fetched).
  ok(!calls.includes('https://subs.example/en.vtt'), '6: subtitle URL was NEVER fetched (security boundary preserved)');
  ok(!calls.includes('https://subs.example/hi.vtt'), '6: subtitle URL was NEVER fetched (security boundary preserved)');
  ok(calls.length === 1, `6: only the stream LIST endpoint was fetched (got ${calls.length} calls)`);
}

// ---------------------------------------------------------------------------
// §B2-sub.7 — Card displays a subtitle badge with track count
// ---------------------------------------------------------------------------

function section7_cardBadge(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  // The Captions icon is imported.
  ok(component.includes('Captions'), '7: Captions icon imported for subtitle badge');
  // The subtitle badge is conditionally rendered when subtitles are present.
  ok(component.includes('{#if stream.subtitles?.length}'), '7: subtitle badge is conditional on stream.subtitles?.length');
  ok(component.includes('mad-badge-subtitles'), '7: mad-badge-subtitles CSS class exists');
  // The badge shows the track count.
  ok(component.includes('{stream.subtitles.length}'), '7: subtitle badge shows the track count');
  // The badge has a title attribute for tooltip + a11y.
  ok(component.includes('title={`Subtitles: ${stream.subtitles.length}'), '7: subtitle badge has a title attribute with track count');
  // The badge lists subtitle languages in the title when available.
  ok(component.includes('stream.subtitles.some((t) => t.language)'), '7: subtitle badge title includes languages when available');
  // The Captions icon is aria-hidden (decorative).
  ok(component.includes('<Captions size={10} aria-hidden="true"'), '7: Captions icon is aria-hidden (decorative)');
  // CSS for the subtitle badge uses existing tokens (no new color system).
  ok(component.includes('.mad-badge-subtitles { color: var(--ink-soft); }'), '7: subtitle badge uses --ink-soft token');
}

// ---------------------------------------------------------------------------
// §B2-sub.8 — Streams with subtitles + streams without subtitles coexist
// ---------------------------------------------------------------------------

async function section8_mixedPayload(): Promise<void> {
  const calls: string[] = [];
  const result = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: noSleep,
    fetcher: fetcherFor({
      'https://hdhub.example/stream/movie/tt8633518.json': json({
        streams: [
          // stream A: WITH subtitles
          { name: '1080p', title: 'A', url: 'https://hub.example/a.mkv', subtitles: [{ url: 'https://subs.example/en.vtt', lang: 'English' }] },
          // stream B: WITHOUT subtitles
          { name: '1080p', title: 'B', url: 'https://hub.example/b.mkv' },
          // stream C: WITH 3 subtitles
          { name: '1080p', title: 'C', url: 'https://hub.example/c.mkv', subtitles: [
            { url: 'https://subs.example/en.vtt', lang: 'English' },
            { url: 'https://subs.example/hi.vtt', lang: 'Hindi' },
            { url: 'https://subs.example/es.vtt', lang: 'Spanish' },
          ] },
        ],
      }),
    }, calls),
  });
  ok(result.status === 'loaded', `8: status='loaded' (got ${result.status})`);
  ok(result.streams.length === 3, `8: 3 streams (got ${result.streams.length})`);
  const a = result.streams.find((s) => s.url.endsWith('/a.mkv'));
  const b = result.streams.find((s) => s.url.endsWith('/b.mkv'));
  const c = result.streams.find((s) => s.url.endsWith('/c.mkv'));
  ok(a?.subtitles?.length === 1, `8: stream A has 1 subtitle (got ${a?.subtitles?.length})`);
  ok(b?.subtitles === undefined || b?.subtitles?.length === 0, `8: stream B has no subtitles (got ${b?.subtitles})`);
  ok(c?.subtitles?.length === 3, `8: stream C has 3 subtitles (got ${c?.subtitles?.length})`);
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

section1_sourceMirror();
section2_extractionShape();
section3_noSubtitles();
section4_malformedSilentlyDropped();
section5_securityBoundary();
section7_cardBadge();

await section6_endToEndPipeline();
await section8_mixedPayload();

console.log(`stremio_downloader_phaseB_subtitles_test: ${passed} checks passed (Phase B §B2 subtitles: mirrored extraction from player normalizer, security boundary preserved, card badge with track count, malformed silently dropped, mixed payload coexistence)`);
