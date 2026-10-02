import assert from 'node:assert/strict';
import {
  listCloudStreamExtractors,
  matchCloudStreamExtractor,
  lookupCloudStreamExtractor,
  runCloudStreamExtractor,
} from '$lib/server/cloudstream/extractors/index';
import { createCloudStreamRuntimeContext } from '$lib/server/cloudstream/runtime/context';
import { createMockFetcher, routeTable, PUBLIC_DNS, PRIVATE_DNS, DYNAMIC_URLS_URL, JSON_ROUTE, resetCaches, createCounter } from './cloudstream_cs2_helpers';
import {
  GDFLIX_PAGE_HTML,
  GDFLIX_CF_PAGE_HTML,
  GDFLIX_FASTCLOUD_PAGE_HTML,
  HUBCLOUD_PAGE_HTML,
  HUBCLOUD_CARD_HTML,
  VCLOUD_PAGE_HTML,
} from './cloudstream_cs2_helpers';
import { fetchCloudStreamPage, fetchCloudStreamRedirect } from '$lib/server/cloudstream/security/http';

// CS-2 suite 2: extractor MATCHING (test 7), extractor FAILURE (test 8),
// SSRF rejection (test 12), and the GDFlix / HubCloud / fastdlserver ports
// against deterministic fixture pages. No network.

const counter = createCounter();
const ok = (condition: unknown, label: string) => counter.ok(condition, label, assert.ok);

// ---------------------------------------------------------------------------
// A. Extractor registry + URL matching (test 7)
// ---------------------------------------------------------------------------
{
  const extractors = listCloudStreamExtractors();
  ok(extractors.length === 3, 'A: exactly 3 extractors registered');
  ok(extractors.map((e) => e.id).join(',') === 'gdflix,hubcloud,fastdlserver', 'A: extractor ids');

  ok(matchCloudStreamExtractor('https://new4.gdflix.io/file/abc')?.id === 'gdflix', 'A: gdflix host matches');
  ok(matchCloudStreamExtractor('https://new1.gdflix.io/file/abc')?.id === 'gdflix', 'A: gdflix subdomain matches');
  ok(matchCloudStreamExtractor('https://gdlink.io/x')?.id === 'gdflix', 'A: gdlink host matches gdflix port');
  ok(matchCloudStreamExtractor('https://hubcloud.ist/dl/abc')?.id === 'hubcloud', 'A: hubcloud host matches');
  ok(matchCloudStreamExtractor('https://vcloud.fit/file/x')?.id === 'hubcloud', 'A: vcloud host matches the hubcloud port');
  ok(matchCloudStreamExtractor('https://fastdlserver.xyz/f/x')?.id === 'fastdlserver', 'A: fastdlserver host matches');
  ok(matchCloudStreamExtractor('https://example.com/file') === null, 'A: unknown host → null');
  ok(matchCloudStreamExtractor('') === null, 'A: empty URL → null');
  ok(lookupCloudStreamExtractor('gdflix')?.id === 'gdflix', 'A: id lookup');
  ok(lookupCloudStreamExtractor('nope') === null, 'A: unknown id lookup → null');
}

// ---------------------------------------------------------------------------
// B. GDFlix port against the fixture page
// ---------------------------------------------------------------------------
{
  resetCaches();
  const routes = routeTable({
    [DYNAMIC_URLS_URL]: { body: JSON.stringify({ gdflix: 'https://gdflix.test' }), contentType: JSON_ROUTE },
    'https://gdflix.test/file/inception-1080': { body: GDFLIX_PAGE_HTML },
    'https://gdflix.test/cf-index?type=1': { body: GDFLIX_CF_PAGE_HTML },
    'https://gdflix.test/cf-index?type=2': { body: GDFLIX_CF_PAGE_HTML },
    'https://gdflix.test/fast-cloud': { body: GDFLIX_FASTCLOUD_PAGE_HTML },
    'https://gdflix.test/instant/xyz': { status: 302, location: 'https://instant.test/dl?url=https://instantreal.test/file.mkv' },
  });
  const ctx = createCloudStreamRuntimeContext({
    adapterId: 'test-gdflix',
    signal: new AbortController().signal,
    fetcher: createMockFetcher(routes),
    dnsResolver: PUBLIC_DNS,
  });

  const links = await runCloudStreamExtractor('https://old.gdflix.io/file/inception-1080', ctx, { adapterId: 'test-gdflix' });
  ok(links.length >= 5, `B: gdflix page walk emitted links (got ${links.length})`);
  const urls = links.map((l) => l.url);

  ok(urls.includes('https://gdflix.test/dl/fsl/abc'), 'B: FSL V2 direct link emitted');
  ok(urls.includes('https://gdflix.test/dl/direct/abc'), 'B: DIRECT DL link emitted');
  ok(urls.includes('https://cf1.gdflix.test/real/file'), 'B: GD Index CF link resolved via ?type pages');
  ok(urls.includes('https://fastcloud.gdflix.test/file'), 'B: FAST CLOUD link resolved via card page');
  ok(urls.includes('https://pixeldrain.com/api/file/abc123?download'), 'B: pixeldrain link converted to API download URL');
  ok(urls.includes('https://instantreal.test/file.mkv'), 'B: Instant DL redirect followed and url= stripped');
  ok(urls.includes('https://gdflix.test/file/inception-1080') === false, 'B: no self-referential link');

  const first = links[0]!;
  ok(first.filename === 'Inception.2010.1080p.BluRay.x264.mkv', 'B: file name captured from Name row');
  ok(first.sizeBytes === 2_400_000_000, 'B: size parsed from Size row');
  ok(first.quality === '1080p', 'B: quality derived from file name');
  ok(first.extractor === 'gdflix', 'B: extractor attribution');
  ok(first.kind === 'https', 'B: kind classified');
}

// ---------------------------------------------------------------------------
// C. HubCloud port (hubcloud dynamic key, var url resolution)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const routes = routeTable({
    [DYNAMIC_URLS_URL]: { body: JSON.stringify({ hubcloud: 'https://hubcloud.test' }), contentType: JSON_ROUTE },
    'https://hubcloud.test/dl/hub-1080': { body: HUBCLOUD_PAGE_HTML },
    'https://hubcloud.test/download/abc': { body: HUBCLOUD_CARD_HTML },
    'https://buzz.hubcloud.test/b1/download': { status: 200, headers: { 'hx-redirect': '/real/buzz-file' } },
  });
  const ctx = createCloudStreamRuntimeContext({
    adapterId: 'test-hubcloud',
    signal: new AbortController().signal,
    fetcher: createMockFetcher(routes),
    dnsResolver: PUBLIC_DNS,
  });

  const links = await runCloudStreamExtractor('https://old.hubcloud.work/dl/hub-1080', ctx, { adapterId: 'test-hubcloud' });
  const urls = links.map((l) => l.url);
  ok(urls.includes('https://fsl.hubcloud.test/file1'), 'C: FSL Server button emitted');
  ok(urls.includes('https://hubcloud.test/dl/file2'), 'C: Download File button emitted');
  ok(urls.includes('https://buzz.hubcloud.test/real/buzz-file'), 'C: BuzzServer hx-redirect resolved');
  ok(links[0]?.quality === '1080p', 'C: quality from card header');
  ok(links[0]?.sizeBytes === 2_400_000_000, 'C: size from i#size');
  ok(links.every((l) => l.extractor === 'hubcloud'), 'C: hubcloud attribution on every link');
}

// ---------------------------------------------------------------------------
// D. VCloud variant (double atob resolution)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const routes = routeTable({
    [DYNAMIC_URLS_URL]: { body: JSON.stringify({ vcloud: 'https://vcloud.test' }), contentType: JSON_ROUTE },
    'https://vcloud.test/file/vc-1080': { body: VCLOUD_PAGE_HTML },
    'https://vcloud.test/download/vc-abc': { body: HUBCLOUD_CARD_HTML },
  });
  const ctx = createCloudStreamRuntimeContext({
    adapterId: 'test-vcloud',
    signal: new AbortController().signal,
    fetcher: createMockFetcher(routes),
    dnsResolver: PUBLIC_DNS,
  });

  const links = await runCloudStreamExtractor('https://old.vcloud.work/file/vc-1080', ctx, { adapterId: 'test-vcloud' });
  const urls = links.map((l) => l.url);
  ok(urls.includes('https://fsl.hubcloud.test/file1'), 'D: vcloud page resolved through double-atob var url');
  ok(links.every((l) => l.sourceName.startsWith('V-Cloud')), 'D: vcloud links labeled V-Cloud');
}

// ---------------------------------------------------------------------------
// E. fastdlserver port (redirect hop → re-dispatch)
// ---------------------------------------------------------------------------
{
  resetCaches();
  const routes = routeTable({
    [DYNAMIC_URLS_URL]: { body: JSON.stringify({ gdflix: 'https://gdflix.test' }), contentType: JSON_ROUTE },
    'https://fastdlserver.test/f/inception-1080': { status: 302, location: 'https://gdflix.test/file/inception-1080' },
    'https://gdflix.test/file/inception-1080': { body: GDFLIX_PAGE_HTML },
    'https://gdflix.test/cf-index?type=1': { body: GDFLIX_CF_PAGE_HTML },
    'https://gdflix.test/cf-index?type=2': { body: GDFLIX_CF_PAGE_HTML },
    'https://gdflix.test/fast-cloud': { body: GDFLIX_FASTCLOUD_PAGE_HTML },
    'https://gdflix.test/instant/xyz': { status: 302, location: 'https://instant.test/dl?url=https://instantreal.test/file.mkv' },
  });
  const ctx = createCloudStreamRuntimeContext({
    adapterId: 'test-fastdl',
    signal: new AbortController().signal,
    fetcher: createMockFetcher(routes),
    dnsResolver: PUBLIC_DNS,
  });

  const links = await runCloudStreamExtractor('https://fastdlserver.test/f/inception-1080', ctx, { adapterId: 'test-fastdl' });
  ok(links.length >= 5, 'E: fastdlserver hop re-dispatched into the gdflix port');
  ok(links.some((l) => l.url === 'https://gdflix.test/dl/fsl/abc'), 'E: downstream links carry the gdflix results');
}

// ---------------------------------------------------------------------------
// F. Extractor failure isolation (test 8)
// ---------------------------------------------------------------------------
{
  resetCaches();
  // GDFlix page missing (404) → extractor returns [], never throws.
  const routes = routeTable({
    [DYNAMIC_URLS_URL]: { body: JSON.stringify({ gdflix: 'https://gdflix.test' }), contentType: JSON_ROUTE },
  });
  const ctx = createCloudStreamRuntimeContext({
    adapterId: 'test-fail',
    signal: new AbortController().signal,
    fetcher: createMockFetcher(routes),
    dnsResolver: PUBLIC_DNS,
  });

  const links = await runCloudStreamExtractor('https://gdflix.test/file/missing', ctx, { adapterId: 'test-fail' });
  ok(Array.isArray(links) && links.length === 0, 'F: HTTP failure → empty array (never throws)');

  // Malformed page (no server buttons) → empty, no throw.
  const routes2 = routeTable({
    [DYNAMIC_URLS_URL]: { body: JSON.stringify({ gdflix: 'https://gdflix.test' }), contentType: JSON_ROUTE },
    'https://gdflix.test/file/bad': { body: '<html><body>nothing here</body></html>' },
  });
  const ctx2 = createCloudStreamRuntimeContext({
    adapterId: 'test-fail',
    signal: new AbortController().signal,
    fetcher: createMockFetcher(routes2),
    dnsResolver: PUBLIC_DNS,
  });
  const links2 = await runCloudStreamExtractor('https://gdflix.test/file/bad', ctx2, { adapterId: 'test-fail' });
  ok(links2.length === 0, 'F: malformed page → empty array');

  // Unknown host → honest empty (no Mavero-owned extractor).
  const ctx3 = createCloudStreamRuntimeContext({
    adapterId: 'test-fail',
    signal: new AbortController().signal,
    fetcher: createMockFetcher(routes),
    dnsResolver: PUBLIC_DNS,
  });
  const links3 = await runCloudStreamExtractor('https://unknown-host.test/file/x', ctx3, { adapterId: 'test-fail' });
  ok(links3.length === 0, 'F: unknown host → empty (no invented extraction)');

  // Diagnostics recorded the failures.
  const events = ctx.diagnostics.events();
  ok(events.some((e) => e.stage === 'extractor' && e.success === false && e.extractorId === 'gdflix'), 'F: extractor failure recorded in diagnostics');
}

// ---------------------------------------------------------------------------
// G. SSRF rejection (test 12) — every fetch path rejects private destinations
// ---------------------------------------------------------------------------
{
  // G1: IP-literal private address rejected at the synchronous URL gate.
  await assert.rejects(
    () => fetchCloudStreamPage('https://192.168.1.1/page', { dnsResolver: PUBLIC_DNS }),
    (error: unknown) => {
      const code = (error as { code?: string }).code;
      ok(code === 'BLOCKED_URL', 'G: private IPv4 literal rejected (BLOCKED_URL)');
      return true;
    },
  );
  await assert.rejects(
    () => fetchCloudStreamPage('https://127.0.0.1:8080/page', { dnsResolver: PUBLIC_DNS }),
    () => {
      counter.bump();
      return true;
    },
  );
  await assert.rejects(
    () => fetchCloudStreamPage('http://localhost/page', { dnsResolver: PUBLIC_DNS }),
    () => {
      counter.bump();
      return true;
    },
  );
  await assert.rejects(
    () => fetchCloudStreamPage('http://metadata.google.internal/meta', { dnsResolver: PUBLIC_DNS }),
    () => {
      counter.bump();
      return true;
    },
  );
  await assert.rejects(
    () => fetchCloudStreamPage('https://169.254.169.254/latest/meta-data', { dnsResolver: PUBLIC_DNS }),
    () => {
      counter.bump();
      return true;
    },
  );
  // Unsafe protocol.
  await assert.rejects(
    () => fetchCloudStreamPage('ftp://example.com/file', { dnsResolver: PUBLIC_DNS }),
    () => {
      counter.bump();
      return true;
    },
  );

  // G2: DNS name resolving to a private address rejected at the destination gate.
  await assert.rejects(
    () => fetchCloudStreamPage('https://internal.example.com/page', { dnsResolver: PRIVATE_DNS }),
    (error: unknown) => {
      const code = (error as { code?: string }).code;
      ok(code === 'BLOCKED_URL', 'G: private DNS resolution rejected (BLOCKED_URL)');
      return true;
    },
  );

  // G3: the no-redirect probe path is equally guarded.
  await assert.rejects(
    () => fetchCloudStreamRedirect('https://10.0.0.1/probe'),
    () => {
      counter.bump();
      return true;
    },
  );

  // G4: extractor URL dispatch with a private destination never fetches.
  const fetchCalls: string[] = [];
  const trackingFetcher: typeof fetch = async (input) => {
    fetchCalls.push(String(input));
    return new Response('<html></html>');
  };
  const ctx = createCloudStreamRuntimeContext({
    adapterId: 'test-ssrf',
    signal: new AbortController().signal,
    fetcher: trackingFetcher,
    dnsResolver: PRIVATE_DNS,
  });
  const blocked = await runCloudStreamExtractor('https://evil-gdflix.attacker.test/file/x', ctx, { adapterId: 'test-ssrf' });
  ok(blocked.length === 0, 'G: extractor dispatch with private DNS yields no links');
  ok(fetchCalls.length === 0, 'G: no fetch left the process (blocked before connect)');
}

// ---------------------------------------------------------------------------
// H. Response size cap
// ---------------------------------------------------------------------------
{
  const hugeHtml = `<html><body>${'x'.repeat(3 * 1_048_576)}</body></html>`;
  const routes = routeTable({
    'https://gdflix.test/huge': { body: hugeHtml },
  });
  await assert.rejects(
    () => fetchCloudStreamPage('https://gdflix.test/huge', { fetcher: createMockFetcher(routes), dnsResolver: PUBLIC_DNS, maxBytes: 1_048_576 }),
    (error: unknown) => {
      const code = (error as { code?: string }).code;
      ok(code === 'TOO_LARGE', 'H: response exceeding the byte cap rejected');
      return true;
    },
  );
}

console.log(counter.summary('cloudstream_extractors_test'));
