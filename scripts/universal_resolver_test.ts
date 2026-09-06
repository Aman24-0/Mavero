import assert from 'node:assert/strict';
import { DiscoveryError } from '../src/lib/server/discovery/errors';
import { genericDiscoveryDetectors } from '../src/lib/server/discovery/detectors';
import { normalizeCandidate, normalizeCandidates } from '../src/lib/server/discovery/normalization';
import { canonicalUrl, deduplicateCandidates, qualityFromText } from '../src/lib/server/discovery/parsing';
import { toPlayerCompatibleSource } from '../src/lib/server/discovery/player-source';
import { createDefaultDiscoveryRegistry, createDiscoveryRegistry } from '../src/lib/server/discovery/registry';
import { discoverPublicPage, fetchPublicPage, pageFromHtml, resolveDiscoveredPage, withTimeout } from '../src/lib/server/discovery/service';
import type { DiscoveryDetector, DiscoveryResolver, MediaCandidate } from '../src/lib/server/discovery/types';

const pageUrl = 'https://public.example/watch/movie';
const fixtureHtml = `
  <video>
    <source src="/media/feature-1080p.mp4" type="video/mp4">
    <track kind="subtitles" src="/captions/en.vtt" srclang="en" label="English">
  </video>
  <script>
    const runtime = {
      hls: "https://cdn.example/feature-1080p.m3u8",
      dash: "https://cdn.example/feature-720p.mpd",
      embed_url: "https://embed.example/watch/feature-123"
    };
  </script>
  <div data-stream-url="https://cdn.example/feature-480p.webm"></div>
`;

const page = pageFromHtml(pageUrl, fixtureHtml);
const result = await resolveDiscoveredPage(page);

assert.ok(result.diagnostics.methodsAttempted.includes('html-media'));
assert.ok(result.diagnostics.methodsAttempted.includes('manifest-url'));
assert.ok(result.diagnostics.methodsAttempted.includes('embed-url'));
assert.ok(result.diagnostics.methodsAttempted.includes('runtime-metadata'));
assert.equal(result.diagnostics.candidatesFound, 5);
assert.equal(result.streams.length, 5);
assert.equal(result.diagnostics.finalStreamCount, 5);
assert.ok(result.streams.some((stream) => stream.type === 'embed' && stream.url.startsWith('https://embed.example/')));
assert.ok(result.streams.some((stream) => stream.protocol === 'hls' && stream.quality === 1080));
assert.ok(result.streams.some((stream) => stream.protocol === 'dash' && stream.quality === 720));
const mp4 = result.streams.find((stream) => stream.protocol === 'mp4');
assert.ok(mp4);
assert.equal(mp4.subtitles[0]?.language, 'en');
assert.equal(mp4.subtitles[0]?.label, 'English');

const mapped = toPlayerCompatibleSource(result.streams[0]!, 'movie');
assert.equal(mapped.providerId, `universal:${result.streams[0]!.resolverId}`);
assert.equal(mapped.type, result.streams[0]!.type);
assert.equal(mapped.mediaType, 'movie');
assert.match(mapped.sourceId, /^universal:/);

assert.equal(qualityFromText('Cinematic 1080p WEB-DL'), 1080);
assert.equal(qualityFromText('4K HDR'), 2160);
assert.equal(qualityFromText('unknown quality'), undefined);
assert.equal(canonicalUrl('https://cdn.example/video.m3u8?utm_source=test&token=abc#fragment'), 'https://cdn.example/video.m3u8?token=abc');

const duplicate: MediaCandidate = {
  url: 'https://cdn.example/video.m3u8?utm_source=one',
  type: 'hls',
  originUrl: pageUrl,
  discoveryMethod: 'manifest-url',
  resolverId: 'test',
  confidence: 0.7,
};
const strongerDuplicate = { ...duplicate, url: 'https://cdn.example/video.m3u8?utm_source=two', confidence: 0.9, quality: 1080 as const };
assert.equal(deduplicateCandidates([duplicate, strongerDuplicate]).length, 1);
assert.equal(deduplicateCandidates([duplicate, strongerDuplicate])[0]?.quality, 1080);
assert.equal(normalizeCandidates([{ ...duplicate, url: 'https://localhost/private.m3u8' }, duplicate]).length, 1);
assert.throws(() => normalizeCandidate({ ...duplicate, url: 'https://cdn.example/file.xyz', type: 'media' }), (error: unknown) => error instanceof DiscoveryError && error.code === 'UNSUPPORTED_FORMAT');

const disabledDetector: DiscoveryDetector = { id: 'disabled', method: 'public-api', enabled: false, detect: () => { throw new Error('disabled detector ran'); } };
const registry = createDiscoveryRegistry([...genericDiscoveryDetectors, disabledDetector]);
const registryResult = await resolveDiscoveredPage(page, registry);
assert.equal(registryResult.diagnostics.methodsAttempted.filter((method) => method === 'public-api').length, 1);

const throwingResolver: DiscoveryResolver = {
  id: 'throwing-resolver',
  name: 'Throwing resolver',
  priority: 1,
  timeoutMs: 100,
  supports: (candidate) => candidate.type === 'hls',
  resolve: async () => { throw new DiscoveryError('RESOLUTION_FAILED'); },
};
const isolatedRegistry = createDiscoveryRegistry(genericDiscoveryDetectors, [throwingResolver, createDefaultDiscoveryRegistry().resolvers[0]!]);
const isolatedResult = await resolveDiscoveredPage(page, isolatedRegistry);
assert.ok(isolatedResult.streams.some((stream) => stream.protocol === 'hls'));
assert.ok(isolatedResult.diagnostics.failures.some((failure) => failure.resolverId === 'throwing-resolver'));

await assert.rejects(() => withTimeout(new Promise<never>(() => {}), 5, new AbortController().signal), (error: unknown) => error instanceof DiscoveryError && error.code === 'TIMEOUT');
const abortController = new AbortController();
abortController.abort();
await assert.rejects(() => withTimeout(Promise.resolve('never'), 100, abortController.signal), (error: unknown) => error instanceof DiscoveryError && error.code === 'CANCELLED');
const inFlightAbortController = new AbortController();
const inFlight = withTimeout(new Promise<never>(() => {}), 1000, inFlightAbortController.signal);
setTimeout(() => inFlightAbortController.abort(), 5);
await assert.rejects(() => inFlight, (error: unknown) => error instanceof DiscoveryError && error.code === 'CANCELLED');

const redirectFetcher: typeof fetch = async () => new Response('', { status: 302, headers: { location: 'https://localhost/private' } });
await assert.rejects(() => fetchPublicPage({ pageUrl: 'https://public.example/redirect' }, redirectFetcher), (error: unknown) => error instanceof DiscoveryError && error.code === 'BLOCKED_SOURCE');

let fetchCalls = 0;
const fixtureFetcher: typeof fetch = async () => {
  fetchCalls += 1;
  return new Response(fixtureHtml, { status: 200, headers: { 'content-type': 'text/html' } });
};
const fetched = await discoverPublicPage({ pageUrl }, undefined, fixtureFetcher);
assert.equal(fetchCalls, 1);
assert.equal(fetched.streams.length, 5);

const mimePage = pageFromHtml('https://public.example/watch/mime', '<video><source src="https://cdn.example/stream?id=hls" type="application/vnd.apple.mpegurl"><source src="https://cdn.example/stream?id=dash" type="application/dash+xml"></video>');
const mimeResult = await resolveDiscoveredPage(mimePage);
assert.ok(mimeResult.streams.some((stream) => stream.protocol === 'hls'));
assert.ok(mimeResult.streams.some((stream) => stream.protocol === 'dash'));

console.log('Universal resolver tests passed: generic discovery, manifests, direct media, embeds, normalization, deduplication, subtitles, quality, isolation, timeout, cancellation, safety, registry, and player mapping.');
