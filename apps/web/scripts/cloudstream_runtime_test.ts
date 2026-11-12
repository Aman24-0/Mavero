import assert from 'node:assert/strict';
import {
  lookupCloudStreamAdapter,
  lookupCloudStreamAdapterInstance,
  listCloudStreamAdapters,
  deriveAdapterStatus,
} from '$lib/server/cloudstream/adapters/registry';
import {
  parseIndexQuality,
  qualityLabel,
  parseSizeBytes,
  detectCodec,
  detectContainer,
  detectAudioLanguages,
  classifyUrlKind,
  hostOf,
  pixeldrainDownloadUrl,
  dedupeCloudStreamLinks,
  buildNormalizedLink,
} from '$lib/server/cloudstream/normalize/links';
import { rankCandidates, normalizeTitleForMatch, extractYear, parseSeasonNumber, sidexfeeBypass } from '$lib/server/cloudstream/adapters/common';
import { createCloudStreamRuntimeContext } from '$lib/server/cloudstream/runtime/context';
import { toExtensionView } from '$lib/server/cloudstream/extensions/service';
import { CLOUDSTREAM_ADAPTER_CONCURRENCY, CLOUDSTREAM_ADAPTER_TIMEOUT_MS, CLOUDSTREAM_RESOLUTION_TIMEOUT_MS } from '$lib/server/cloudstream/resolver/service';
import { createCounter } from './cloudstream_cs2_helpers';

// CS-2 suite 1: adapter REGISTRY, adapter SELECTION, unsupported-extension
// behavior, compatibility status, NORMALIZATION, diagnostics redaction.
// Deterministic: no network (pure functions + a context with a mock fetcher).

const counter = createCounter();
const ok = (condition: unknown, label: string) => counter.ok(condition, label, assert.ok);

// ---------------------------------------------------------------------------
// A. Adapter registry (test 1)
// ---------------------------------------------------------------------------
{
  const adapters = listCloudStreamAdapters();
  ok(adapters.length === 3, 'A: exactly 3 adapters registered (Bollyflix, MoviesDrive, VegaMovies)');
  const ids = adapters.map((adapter) => adapter.id).sort();
  ok(JSON.stringify(ids) === JSON.stringify(['Bollyflix', 'MoviesDrive', 'VegaMovies']), 'A: adapter ids match the ported set');

  ok(lookupCloudStreamAdapter('Bollyflix')?.version === '1.0.0', 'A: metadata lookup returns version');
  ok(lookupCloudStreamAdapter('bollyflix')?.id === 'Bollyflix', 'A: lookup is case-insensitive (lowercase)');
  ok(lookupCloudStreamAdapter('  BOLLYFLIX ')?.id === 'Bollyflix', 'A: lookup trims whitespace');
  ok(lookupCloudStreamAdapter('CineStream') === null, 'A: CineStream NOT registered (aggregator — adapter_required)');
  ok(lookupCloudStreamAdapter('Moviesmod') === null, 'A: Moviesmod NOT registered (CloudflareKiller dependency)');
  ok(lookupCloudStreamAdapter('') === null, 'A: empty lookup returns null');
  ok(lookupCloudStreamAdapter(null as unknown as string) === null, 'A: non-string lookup returns null');

  const instance = lookupCloudStreamAdapterInstance('vegamovies');
  ok(instance !== null && instance.displayName === 'VegaMovies', 'A: instance lookup returns the adapter object');
  ok(instance !== null && typeof instance.resolveMovie === 'function', 'A: adapter exposes resolveMovie');
  ok(instance !== null && typeof instance.resolveEpisode === 'function', 'A: adapter exposes resolveEpisode');
  for (const adapter of adapters) {
    ok(adapter.supports.movie === true, `A: ${adapter.id} supports movies`);
    ok(adapter.supports.series === true, `A: ${adapter.id} supports series`);
    ok(typeof adapter.version === 'string' && adapter.version.length > 0, `A: ${adapter.id} has a version`);
    ok(typeof adapter.displayName === 'string' && adapter.displayName.length > 0, `A: ${adapter.id} has a displayName`);
  }
}

// ---------------------------------------------------------------------------
// B. Compatibility status (test 15) — deriveAdapterStatus precedence
// ---------------------------------------------------------------------------
{
  ok(deriveAdapterStatus('Bollyflix', 1) === 'compatible', 'B: registered adapter + OK plugin → compatible');
  ok(deriveAdapterStatus('MoviesDrive', null) === 'compatible', 'B: registered adapter + unknown status → compatible');
  ok(deriveAdapterStatus('CineStream', 1) === 'adapter_required', 'B: unregistered + OK → adapter_required (honest)');
  ok(deriveAdapterStatus('Moviesmod', 1) === 'adapter_required', 'B: Moviesmod → adapter_required (not portable, not faked)');
  ok(deriveAdapterStatus('Whatever', null) === 'adapter_required', 'B: unknown plugin status → adapter_required');
  ok(deriveAdapterStatus('Bollyflix', 3) === 'broken', 'B: plugin self-reports BROKEN (3) → broken (overrides registry)');
  ok(deriveAdapterStatus('Bollyflix', 2) === 'unsupported', 'B: plugin self-reports DOWN (2) → unsupported (overrides registry)');
}

// ---------------------------------------------------------------------------
// C. Admin display derivation (live, no re-sync required)
// ---------------------------------------------------------------------------
{
  const baseRow = {
    id: '00000000-0000-4000-8000-000000000001',
    repository_id: '00000000-0000-4000-8000-000000000000',
    internal_name: 'Bollyflix',
    name: 'Bollyflix',
    version: 33,
    api_version: 1,
    description: null,
    authors: [] as string[],
    language: 'hi',
    tv_types: ['Movie', 'TvSeries'],
    plugin_url: null,
    plugin_status: 1,
    icon_url: null,
    file_hash: null,
    file_size_bytes: null,
    source_url: null,
    enabled: false,
    adapter_status: 'adapter_required', // CS-1-era persisted snapshot
    mavero_adapter_id: null,
    adapter_version: null,
    // Phase 2 — unified Extension catalog columns (cloudstream defaults).
    integration_type: 'cloudstream',
    media_types: ['movie', 'tv'],
    adapter_state: 'adapter_required',
    provider_metadata: null,
    module_url: null,
    version_text: null,
    last_tested_at: null,
    last_test_error: null,
    last_checked_at: null,
    last_error: null,
    created_at: '2026-10-02T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
  };
  const view = toExtensionView(baseRow, 'CSX');
  ok(view.adapterStatus === 'compatible', 'C: persisted adapter_required row derives LIVE compatible status');
  ok(view.maveroAdapterId === 'Bollyflix', 'C: live maveroAdapterId populated from registry');
  ok(view.adapterVersion === '1.0.0', 'C: live adapterVersion populated from registry');
  // Phase 2: unified registry fields on the admin view.
  ok(view.integrationType === 'cloudstream', 'C: view carries the integration type');
  ok(view.adapterState === 'disabled', 'C: native adapter + disabled row derives disabled operational state');

  const unregistered = toExtensionView({ ...baseRow, id: '00000000-0000-4000-8000-000000000002', internal_name: 'CineStream' }, 'CSX');
  ok(unregistered.adapterStatus === 'adapter_required', 'C: CineStream still adapter_required in the admin view');
  const broken = toExtensionView({ ...baseRow, id: '00000000-0000-4000-8000-000000000003', internal_name: 'SomePlugin', plugin_status: 3 }, 'CSX');
  ok(broken.adapterStatus === 'broken', 'C: broken plugin status wins over registry absence');
}

// ---------------------------------------------------------------------------
// D. Title matching utilities (adapter selection prerequisites)
// ---------------------------------------------------------------------------
{
  ok(normalizeTitleForMatch('Download Inception (2010)') === 'inception 2010', 'D: title normalization strips Download + punctuation');
  ok(extractYear('Inception (2010) BluRay') === 2010, 'D: year extraction');
  ok(extractYear('no year here') === undefined, 'D: year extraction returns undefined without a year');
  ok(parseSeasonNumber('Season 2 Complete') === 2, 'D: season regex "Season 2"');
  ok(parseSeasonNumber('S04 pack') === 4, 'D: season regex "S04"');
  ok(parseSeasonNumber('no season') === undefined, 'D: season regex returns undefined');

  const ranked = rankCandidates(
    { title: 'Inception', year: 2010 },
    [
      { title: 'Inception (2010) BluRay 1080p', href: 'https://x.test/a' },
      { title: 'Inception (2012) Wrong Year', href: 'https://x.test/b' },
      { title: 'Totally Different Movie', href: 'https://x.test/c' },
    ],
  );
  ok(ranked.length === 2, 'D: implausible candidates dropped');
  ok(ranked[0]?.href === 'https://x.test/a', 'D: exact title + matching year ranks first');
  ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0), 'D: correct year outscores wrong year');

  const noYear = rankCandidates({ title: 'Inception' }, [{ title: 'Inception', href: 'https://x.test/a' }]);
  ok(noYear.length === 1 && noYear[0]?.score === 100, 'D: exact match without year → score 100');
  ok(rankCandidates({ title: '' }, [{ title: 'x', href: 'https://x.test/a' }]).length === 0, 'D: empty requested title → no candidates');
}

// ---------------------------------------------------------------------------
// E. Normalization: quality (test 11)
// ---------------------------------------------------------------------------
{
  ok(parseIndexQuality('1080p') === 1080, 'E: 1080p');
  ok(parseIndexQuality('720P') === 720, 'E: 720P uppercase');
  ok(parseIndexQuality('2160p 4K') === 2160, 'E: 2160p');
  ok(parseIndexQuality('movie 4k hdr') === 2160, 'E: 4k → 2160');
  ok(parseIndexQuality('8k remux') === 4320, 'E: 8k → 4320');
  ok(parseIndexQuality('2k') === 1440, 'E: 2k → 1440');
  ok(parseIndexQuality('no quality') === undefined, 'E: unknown → undefined');
  ok(parseIndexQuality(null) === undefined, 'E: null → undefined');
  ok(qualityLabel(1080) === '1080p', 'E: quality label');
  ok(qualityLabel(undefined) === undefined, 'E: quality label undefined passthrough');
}

// ---------------------------------------------------------------------------
// F. Normalization: size / codec / container / languages
// ---------------------------------------------------------------------------
{
  ok(parseSizeBytes('2.4 GB') === 2_400_000_000, 'F: 2.4 GB → bytes');
  ok(parseSizeBytes('450 MB') === 450_000_000, 'F: 450 MB');
  ok(parseSizeBytes('1.3GB') === 1_300_000_000, 'F: no-space GB');
  ok(parseSizeBytes('1024 kB') === 1_024_000, 'F: kB decimal');
  ok(parseSizeBytes('') === undefined, 'F: empty → undefined');
  ok(parseSizeBytes('99999 TB') === undefined, 'F: absurd size rejected (sanity bound)');

  ok(detectCodec('Movie.x264.1080p.mkv') === 'H.264', 'F: x264 codec');
  ok(detectCodec('Movie.HEVC.mkv') === 'H.265', 'F: HEVC codec');
  ok(detectCodec('Movie.AV1.1080p.mkv') === 'AV1', 'F: AV1 codec');
  ok(detectCodec('plain') === undefined, 'F: no codec → undefined');
  ok(detectContainer('Movie.2020.mkv') === 'MKV', 'F: mkv container');
  ok(detectContainer('Movie.2020.mp4') === 'MP4', 'F: mp4 container');
  ok(detectContainer('Movie.2020.avi') === 'AVI', 'F: avi container');

  ok(JSON.stringify(detectAudioLanguages('Dual Audio Hindi English')) === JSON.stringify(['Hindi', 'English']), 'F: dual audio detection');
  ok(detectAudioLanguages('Korean Series')?.[0] === 'Korean', 'F: Korean detection');
  ok(detectAudioLanguages('') === undefined, 'F: no languages → undefined');
}

// ---------------------------------------------------------------------------
// G. Kind classification + host + pixeldrain
// ---------------------------------------------------------------------------
{
  ok(classifyUrlKind('https://x.test/f.mp4') === 'https', 'G: https kind');
  ok(classifyUrlKind('http://x.test/f.mp4') === 'http', 'G: http kind');
  ok(classifyUrlKind('magnet:?xt=urn:btih:abc') === 'magnet', 'G: magnet kind');
  ok(classifyUrlKind('https://x.test/pl.m3u8') === 'https', 'G: https prefix wins over m3u8 suffix (stream URL)');
  ok(hostOf('https://www.pixeldrain.com/u/abc') === 'pixeldrain.com', 'G: host strips www.');
  ok(hostOf('not-a-url') === undefined, 'G: host undefined for garbage');
  ok(pixeldrainDownloadUrl('https://pixeldrain.com/u/abc123') === 'https://pixeldrain.com/api/file/abc123?download', 'G: pixeldrain viewer → API download URL');
  ok(pixeldrainDownloadUrl('https://pixeldrain.com/api/file/abc123?download') === 'https://pixeldrain.com/api/file/abc123?download', 'G: pixeldrain download URL passthrough');
  ok(pixeldrainDownloadUrl('https://example.com/u/abc') === null, 'G: pixeldrain conversion only for pixeldrain hosts');
}

// ---------------------------------------------------------------------------
// H. Link construction + dedup (test 11)
// ---------------------------------------------------------------------------
{
  const link = buildNormalizedLink(
    {
      url: 'https://gdflix.test/direct/file.mkv',
      kind: 'https',
      filename: 'Inception.2010.1080p.BluRay.x264.mkv',
      sourceName: 'GDFlix [Direct]',
      extractor: 'gdflix',
    },
    'Bollyflix',
  );
  ok(link.quality === '1080p', 'H: quality derived from file name');
  ok(link.codec === 'H.264', 'H: codec derived from file name');
  ok(link.container === 'MKV', 'H: container derived from file name');
  ok(link.provider === 'Bollyflix', 'H: provider attribution');
  ok(link.host === 'gdflix.test', 'H: host derived');
  ok(link.extractor === 'gdflix', 'H: extractor attribution');

  const deduped = dedupeCloudStreamLinks([
    { url: 'https://x.test/a', kind: 'https' as const, provider: 'p', sourceName: 's1' },
    { url: 'https://x.test/a', kind: 'https' as const, provider: 'p', sourceName: 's2' },
    { url: 'https://x.test/b', kind: 'https' as const, provider: 'p', sourceName: 's3' },
  ]);
  ok(deduped.length === 2, 'H: duplicate URLs collapse');
  ok(deduped[0]?.sourceName === 's1', 'H: first occurrence wins');
  ok(dedupeCloudStreamLinks([{ url: '', kind: 'https' as const, provider: 'p', sourceName: 'x' }]).length === 0, 'H: empty URLs dropped');
}

// ---------------------------------------------------------------------------
// I. Diagnostics redaction (test 14)
// ---------------------------------------------------------------------------
{
  const ctx = createCloudStreamRuntimeContext({ adapterId: 'test-adapter', signal: new AbortController().signal });
  ctx.diagnostics.record({
    adapterId: 'test-adapter',
    stage: 'resolve',
    durationMs: 123,
    success: true,
    resultCount: 4,
  });
  ctx.diagnostics.record({
    adapterId: 'test-adapter',
    stage: 'extractor',
    durationMs: 45,
    success: false,
    failureCategory: 'EXTRACTOR_FAILED',
    extractorId: 'gdflix',
  });
  const events = ctx.diagnostics.events();
  ok(events.length === 2, 'I: diagnostics events collected');
  ok(events[0]?.stage === 'resolve' && events[0]?.resultCount === 4, 'I: event fields preserved');
  const serialized = JSON.stringify(events);
  ok(!serialized.includes('http'), 'I: no URLs in serialized diagnostics (redaction-safe)');
  ok(!serialized.includes('cookie') && !serialized.includes('token'), 'I: no cookies/tokens in diagnostics');

  // Event hard bound (256).
  const ctx2 = createCloudStreamRuntimeContext({ adapterId: 'test-bound', signal: new AbortController().signal });
  for (let i = 0; i < 300; i += 1) {
    ctx2.diagnostics.record({ adapterId: 'test-bound', stage: 'resolve', durationMs: 1, success: true });
  }
  ok(ctx2.diagnostics.events().length === 256, 'I: diagnostics event count hard-bounded at 256');
}

// ---------------------------------------------------------------------------
// J. Resolver bounds constants exported
// ---------------------------------------------------------------------------
{
  ok(CLOUDSTREAM_ADAPTER_CONCURRENCY === 4, 'J: adapter concurrency bound is 4 (ADDON_CONCURRENCY parity)');
  ok(CLOUDSTREAM_ADAPTER_TIMEOUT_MS === 30_000, 'J: per-adapter timeout budget 30s');
  ok(CLOUDSTREAM_RESOLUTION_TIMEOUT_MS === 40_000, 'J: overall timeout budget 40s');
}

// ---------------------------------------------------------------------------
// K. sidexfee bypass (Bollyflix ?id= flow) with a mock context
// ---------------------------------------------------------------------------
{
  const ctx = createCloudStreamRuntimeContext({
    adapterId: 'test-bypass',
    signal: new AbortController().signal,
    fetcher: (async () => ({ body: `{"link":"${Buffer.from('https://gdflix.test/file/x').toString('base64').replace(/\//g, '\\/')}"}` })) as unknown as typeof fetch,
  });
  // Note: the mock above returns a plain object, not a Response — the real
  // pipeline needs a Response. Build it properly:
  const realCtx = createCloudStreamRuntimeContext({
    adapterId: 'test-bypass',
    signal: new AbortController().signal,
    fetcher: (async () => new Response(`{"link":"${Buffer.from('https://gdflix.test/file/x').toString('base64')}"}`, { headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch,
  });
  const bypassed = await sidexfeeBypass('abc', realCtx);
  ok(bypassed === 'https://gdflix.test/file/x', 'K: sidexfee bypass decodes the base64 link');
  const failed = await sidexfeeBypass('abc', createCloudStreamRuntimeContext({
    adapterId: 'test-bypass',
    signal: new AbortController().signal,
    fetcher: (async () => new Response('garbage', { status: 500 })) as unknown as typeof fetch,
  }));
  ok(failed === null, 'K: bypass failure → null (honest)');
  void ctx;
}

console.log(counter.summary('cloudstream_runtime_test'));
