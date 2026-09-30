import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { StreamingAddon } from '$lib/shared/streaming-addons';
import {
  resolveSingleAddonDownload,
  type ContentLookup,
} from '$lib/server/streaming/stremio/addon-download-service';
import {
  buildDownloadCandidatesAll,
  selectDownloadStreamsAll,
  type DownloadStreamViewAll,
} from '$lib/server/streaming/stremio/download-selection';
import { normalizeStremioStreamResponseForDownloader } from '$lib/server/streaming/stremio/stream-normalize-downloader';

/**
 * Phase B — Duplicate-link / hosting-server handling test suite.
 *
 * Pins the §B1 dedup contract required by the approved plan:
 *
 *   "REMOVE USELESS DUPLICATES, NOT REMOVE USEFUL DIFFERENT HOST COPIES."
 *
 * The 6 mandatory scenarios from the plan:
 *   1. exact duplicate → removed
 *   2. same release + same host + same target → deduplicated
 *   3. same release + different hosting host → preserved
 *   4. different URL but same underlying hosting target → the actual
 *      architecture gives us URL-level identity (we cannot safely tell
 *      "same underlying target" without fetching, which is forbidden).
 *      So different URLs = different streams (preserved).
 *   5. query/token differences must not accidentally cause uncontrolled
 *      duplicate explosion → our changes only ADD dedup (exact-URL) —
 *      they never inflate duplicates.
 *   6. deduplication must remain deterministic → identical input always
 *      produces identical output, identical order.
 *
 * Plus the magnet-btih dedup scenario (same btih, different trackers →
 * collapsed) since the plan covers magnet URIs implicitly via "same
 * underlying hosting target".
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
const PIPE = addonFixture({ id: '00000000-0000-4000-8000-14000000pipe', name: 'Pipe', slug: 'pipe', manifestUrl: 'https://pipe.example/manifest.json', ordering: 2 });

const CONTENT: ContentLookup = { title: 'Dhurandhar: The Revenge', identifiers: { imdbId: 'tt8633518', tmdbId: '1094521' }, runtimeSeconds: 3 * 3600 + 49 * 60 };
const loadContentOf = (lookup: ContentLookup) => async () => lookup;
const loadAddonsOf = (addons: StreamingAddon[]) => async () => addons;
const loadAddonByIdOf = (addons: StreamingAddon[]) => async (_client: unknown, id: string) => addons.find((addon) => addon.id === id) ?? null;

const movieRequest = { mediaType: 'movie' as const, contentId: 'movie-1094521' };

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

/** Phase B test fetcher — returns a CLONE of the stored Response so retries see a fresh body. */
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

/** Convenience: normalize a raw Stremio streams payload through the downloader normalizer. */
function normalize(payload: unknown) {
  return normalizeStremioStreamResponseForDownloader(payload).entries;
}

/** Convenience: build + select in one call (mirrors what resolveSingleAddonDownload does). */
function selectAll(entries: ReturnType<typeof normalize>): DownloadStreamViewAll[] {
  const { entries: built } = buildDownloadCandidatesAll(entries);
  return selectDownloadStreamsAll(built);
}

// ---------------------------------------------------------------------------
// §B1.1 — EXACT DUPLICATE → removed
// ---------------------------------------------------------------------------

async function section1_exactDuplicate(): Promise<void> {
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
          { name: 'a', title: '1080p WEB-DL', url: 'https://hub.example/movie.mkv', behaviorHints: { videoSize: 4_724_904_960, filename: 'Dhurandhar.1080p.WEB-DL.H264.mkv' } },
          // EXACT duplicate — same URL, same everything. The addon offered the same stream twice.
          { name: 'a', title: '1080p WEB-DL', url: 'https://hub.example/movie.mkv', behaviorHints: { videoSize: 4_724_904_960, filename: 'Dhurandhar.1080p.WEB-DL.H264.mkv' } },
        ],
      }),
    }, calls),
  });
  ok(result.status === 'loaded', `1: status='loaded' (got ${result.status})`);
  ok(result.streams.length === 1, `1: EXACT duplicate removed → 1 stream (got ${result.streams.length})`);
  ok(result.streams[0]?.url === 'https://hub.example/movie.mkv', '1: the surviving stream is the original URL');
  ok(result.diagnostics?.raw === 2, `1: diagnostics.raw = 2 (both entries counted before dedup) (got ${result.diagnostics?.raw})`);
  ok(result.diagnostics?.selected === 1, `1: diagnostics.selected = 1 (after dedup) (got ${result.diagnostics?.selected})`);
}

// ---------------------------------------------------------------------------
// §B1.2 — SAME release + SAME host + SAME target → deduplicated
// ---------------------------------------------------------------------------

async function section2_sameReleaseSameHost(): Promise<void> {
  // The addon returns the SAME URL twice but with DIFFERENT display metadata
  // (different name, different title). The URL is the same → it's the same
  // underlying stream → the higher-ranked one wins, the other collapses.
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
          { name: '#1', title: 'Dhurandhar 1080p WEB-DL H264 8.8GB', url: 'https://hub.example/movie.mkv' },
          { name: '#2 Mirror', title: 'Dhurandhar 1080p WEB-DL H264 8.8GB', url: 'https://hub.example/movie.mkv' },
        ],
      }),
    }, calls),
  });
  ok(result.status === 'loaded', `2: status='loaded' (got ${result.status})`);
  ok(result.streams.length === 1, `2: same release + same host + same target → deduplicated to 1 (got ${result.streams.length})`);
  ok(result.streams[0]?.url === 'https://hub.example/movie.mkv', '2: the surviving stream is the canonical URL');
}

// ---------------------------------------------------------------------------
// §B1.3 — SAME release + DIFFERENT hosting host → PRESERVED
// (the critical "useful different host copies" rule from the approved plan)
// ---------------------------------------------------------------------------

async function section3_sameReleaseDifferentHost(): Promise<void> {
  // Two streams with IDENTICAL release metadata (same filename, same quality,
  // same codec, same size, same display text) but on DIFFERENT hosting
  // infrastructure: PixelDrain vs FSL vs CineDoze. The plan EXPLICITLY says
  // these MUST NOT collapse — different host = different hosting
  // infrastructure = useful alternative that survives.
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
          { name: 'a', title: 'Dhurandhar 1080p WEB-DL H264 8.8GB', url: 'https://pixeldrain.com/api/file/abc123.mkv', behaviorHints: { videoSize: 9_449_809_920, filename: 'Dhurandhar.1080p.WEB-DL.H264.mkv' } },
          { name: 'b', title: 'Dhurandhar 1080p WEB-DL H264 8.8GB', url: 'https://fsl.example.com/files/def456.mkv', behaviorHints: { videoSize: 9_449_809_920, filename: 'Dhurandhar.1080p.WEB-DL.H264.mkv' } },
          { name: 'c', title: 'Dhurandhar 1080p WEB-DL H264 8.8GB', url: 'https://cinedoze.example/g/ghi789.mkv', behaviorHints: { videoSize: 9_449_809_920, filename: 'Dhurandhar.1080p.WEB-DL.H264.mkv' } },
        ],
      }),
    }, calls),
  });
  ok(result.status === 'loaded', `3: status='loaded' (got ${result.status})`);
  ok(result.streams.length === 3, `3: same release + DIFFERENT hosts → ALL 3 PRESERVED (got ${result.streams.length}) — NOT collapsed`);
  const hosts = result.streams.map((s) => s.host).sort();
  ok(JSON.stringify(hosts) === JSON.stringify(['cinedoze.example', 'fsl.example.com', 'pixeldrain.com']), `3: each stream carries its own host identity (got ${JSON.stringify(hosts)})`);
}

// ---------------------------------------------------------------------------
// §B1.4 — DIFFERENT URL but same underlying hosting target → preserved
// (we cannot safely determine "same underlying target" without fetching
// the URL, which the security boundary forbids. So different URL = different
// stream. This is the safe default that never collapses a useful alternative.)
// ---------------------------------------------------------------------------

async function section4_differentUrlSameTarget(): Promise<void> {
  // Two streams on the SAME hosting server (fsl.example.com) but DIFFERENT
  // path (different file IDs). They MIGHT be the same file mirrored under
  // two IDs, OR they might be different files. Without fetching (forbidden),
  // we can't tell. The safe default: treat them as distinct → both survive.
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
          { name: 'a', title: '1080p', url: 'https://fsl.example.com/files/file-id-aaa.mkv' },
          { name: 'b', title: '1080p', url: 'https://fsl.example.com/files/file-id-bbb.mkv' },
        ],
      }),
    }, calls),
  });
  ok(result.status === 'loaded', `4: status='loaded' (got ${result.status})`);
  ok(result.streams.length === 2, `4: different URLs on same host → BOTH PRESERVED (got ${result.streams.length}) — we don't guess whether they're the same file`);
}

// ---------------------------------------------------------------------------
// §B1.5 — QUERY/TOKEN differences must not ACCIDENTALLY cause uncontrolled
// duplicate explosion. Our changes only ADD dedup (exact-URL) — they never
// inflate duplicates. A token-variant URL is treated as a distinct stream
// (the safe default — we cannot tell a cache-buster from a meaningful
// file-id parameter without fetching). 5 token variants → 5 distinct streams.
// This is NOT an "explosion" introduced by Phase B — it's the existing
// per-addon behavior preserved; Phase B's contribution is REMOVING exact
// duplicates (the same URL offered twice), not ADDING fake variants.
// ---------------------------------------------------------------------------

async function section5_queryTokenDifferences(): Promise<void> {
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
          // 5 streams on the same host with the SAME path but DIFFERENT
          // query tokens. Without fetching, we cannot tell whether the
          // token is a cache-buster (same file) or a meaningful file-id
          // (different files). The safe default: preserve all 5.
          { name: 'a', title: '1080p', url: 'https://cdn.example/file.mkv?token=abc' },
          { name: 'b', title: '1080p', url: 'https://cdn.example/file.mkv?token=def' },
          { name: 'c', title: '1080p', url: 'https://cdn.example/file.mkv?token=ghi' },
          // 2 EXACT duplicates (same URL) — these MUST be removed.
          { name: 'd', title: '1080p', url: 'https://cdn.example/file.mkv?token=abc' },
          { name: 'e', title: '1080p', url: 'https://cdn.example/file.mkv?token=abc' },
        ],
      }),
    }, calls),
  });
  ok(result.status === 'loaded', `5: status='loaded' (got ${result.status})`);
  // 5 input entries → 3 distinct canonical URLs (3 distinct tokens) → 3 shown.
  // The 2 exact duplicates (same token=abc) are removed.
  ok(result.streams.length === 3, `5: 3 distinct token-variants preserved, 2 exact duplicates removed (got ${result.streams.length})`);
  ok(result.diagnostics?.raw === 5, `5: diagnostics.raw = 5 (all input entries counted) (got ${result.diagnostics?.raw})`);
  ok(result.diagnostics?.selected === 3, `5: diagnostics.selected = 3 (after dedup) (got ${result.diagnostics?.selected})`);
}

// ---------------------------------------------------------------------------
// §B1.6 — DEDUPLICATION must remain DETERMINISTIC
// ---------------------------------------------------------------------------

async function section6_deterministic(): Promise<void> {
  // Run the same input through the pipeline twice — the output must be
  // byte-for-byte identical (same order, same URLs, same metadata).
  const payload = {
    streams: [
      { name: 'a', title: '1080p', url: 'https://hub.example/a.mkv' },
      { name: 'b', title: '720p', url: 'https://hub.example/b.mkv' },
      { name: 'c', title: '480p', url: 'https://hub.example/a.mkv' }, // exact dupe of a
      { name: 'd', title: '1080p', url: 'https://hub.example/d.mkv' },
      { name: 'e', title: '1080p', url: 'https://hub.example/a.mkv' }, // exact dupe of a
    ],
  };
  const run1 = selectAll(normalize(payload));
  const run2 = selectAll(normalize(payload));
  const urls1 = run1.map((s) => s.url).join('|');
  const urls2 = run2.map((s) => s.url).join('|');
  ok(urls1 === urls2, `6: deterministic — same input produces same URL list (got ${urls1} vs ${urls2})`);
  ok(run1.length === 3, `6: dedup result is 3 streams (got ${run1.length})`);
  ok(urls1 === 'https://hub.example/a.mkv|https://hub.example/d.mkv|https://hub.example/b.mkv', `6: deterministic ORDER — a (highest rank) first, then d, then b (got ${urls1})`);
  // Also verify the per-addon endpoint is deterministic across two calls.
  const calls1: string[] = [];
  const calls2: string[] = [];
  const r1 = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: noSleep,
    fetcher: fetcherFor({ 'https://hdhub.example/stream/movie/tt8633518.json': json(payload) }, calls1),
  });
  const r2 = await resolveSingleAddonDownload({} as never, movieRequest, HUB.id, {
    loadAddons: loadAddonsOf([HUB]),
    loadAddonById: loadAddonByIdOf([HUB]),
    loadContent: loadContentOf(CONTENT),
    dnsResolver: publicDns,
    sleep: noSleep,
    fetcher: fetcherFor({ 'https://hdhub.example/stream/movie/tt8633518.json': json(payload) }, calls2),
  });
  ok(r1.streams.length === r2.streams.length, `6: endpoint deterministic — same stream count across calls (got ${r1.streams.length} vs ${r2.streams.length})`);
  ok(JSON.stringify(r1.streams.map((s) => s.url)) === JSON.stringify(r2.streams.map((s) => s.url)), '6: endpoint deterministic — same URL order across calls');
}

// ---------------------------------------------------------------------------
// §B1.7 — MAGNET btih dedup (same btih + different trackers → collapsed)
// ---------------------------------------------------------------------------

async function section7_magnetBtihDedup(): Promise<void> {
  // Two magnet URIs with the SAME btih but different tracker orderings and
  // different display names. They're the SAME torrent → dedup to ONE.
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
          { name: 'torrent-1', title: 'Dhurandhar 1080p', url: 'magnet:?xt=urn:btih:deadbeef0123456789abcdef0123456789abcdef&dn=Dhurandhar.1080p&tr=udp://tracker1.example:1337&tr=https://tracker2.example/announce' },
          { name: 'torrent-2', title: 'Dhurandhar 1080p (mirror)', url: 'magnet:?xt=urn:btih:deadbeef0123456789abcdef0123456789abcdef&dn=Dhurandhar.1080p.Mirror&tr=https://tracker2.example/announce&tr=udp://tracker1.example:1337' },
          // A DIFFERENT btih — this is a genuinely different torrent. Must survive.
          { name: 'torrent-3', title: 'Dhurandhar 720p', url: 'magnet:?xt=urn:btih:feedface0123456789abcdef0123456789abcdef&dn=Dhurandhar.720p' },
        ],
      }),
    }, calls),
  });
  ok(result.status === 'loaded', `7: status='loaded' (got ${result.status})`);
  // 2 same-btih magnets collapse; 1 different-btih magnet survives. Total = 2.
  ok(result.streams.length === 2, `7: same-btih magnets dedup, different-btih preserved (got ${result.streams.length})`);
  ok(result.streams.some((s) => s.url.includes('feedface')), '7: the different-btih magnet is preserved');
  ok(result.streams.filter((s) => s.url.includes('deadbeef')).length === 1, '7: the same-btih magnets collapsed to ONE');
}

// ---------------------------------------------------------------------------
// §B1.8 — Source-level contract: dedup key is URL-only (never metadata)
// ---------------------------------------------------------------------------

function section8_sourceContract(): void {
  const selectionSource = read('src/lib/server/streaming/stremio/download-selection.ts');
  // §B1: the canonical-stream-key helper exists and is URL-based.
  ok(selectionSource.includes('function canonicalStreamKey'), '8: canonicalStreamKey helper is in the source');
  ok(selectionSource.includes("url.startsWith('magnet:?')"), '8: magnet btih normalization branch exists');
  ok(selectionSource.includes('xt=urn:btih:'), '8: btih extraction regex is in the source');
  // §B1: the per-addon selection function actually applies dedup (not a no-op).
  ok(selectionSource.includes('const seen = new Set<string>();'), '8: selectDownloadStreamsAll has a seen-set for dedup');
  ok(selectionSource.includes('if (seen.has(key)) continue;'), '8: selectDownloadStreamsAll skips seen keys (dedup is active)');
  // §B1: the host field is exposed on the view (card UX §B2 plumbing).
  ok(selectionSource.includes('host?: string'), '8: DownloadStreamViewAll.host field is declared');
  ok(selectionSource.includes('function hostOf'), '8: hostOf helper is in the source');
  ok(selectionSource.includes('...(host ? { host } : {})'), '8: buildDownloadCandidatesAll populates host');
  // §B2: the AddonDownloadStreamView (public API) also exposes host.
  const serviceSource = read('src/lib/server/streaming/stremio/addon-download-service.ts');
  ok(serviceSource.includes('host?: string'), '8: AddonDownloadStreamView.host field is declared on the public API');
  ok(serviceSource.includes('...(stream.host ? { host: stream.host } : {})'), '8: toStreamViewAll plumbs host through to the client');
  // §B1: the existing batch-path dedup (canonical-URL) is preserved.
  ok(selectionSource.includes('function canonicalUrlKey'), '8: batch-path canonicalUrlKey helper is preserved (back-compat)');
  // §B1: the old "no dedup on discovery path" comment is GONE — replaced by the active dedup.
  ok(!selectionSource.includes('True-duplicate dedup is intentionally DISABLED for the discovery path'), '8: the old "dedup is DISABLED" comment is removed (dedup is now active)');
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

section8_sourceContract();

await section1_exactDuplicate();
await section2_sameReleaseSameHost();
await section3_sameReleaseDifferentHost();
await section4_differentUrlSameTarget();
await section5_queryTokenDifferences();
await section6_deterministic();
await section7_magnetBtihDedup();

console.log(`stremio_downloader_phaseB_dedup_test: ${passed} checks passed (Phase B §B1: duplicate-link / hosting-server handling — exact dupes removed, useful different-host copies preserved, magnet btih dedup, deterministic ordering, URL-only identity key)`);
