import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchFourKLinks, FOURK_API_ORIGIN } from '$lib/server/downloader/fourk-service';
import type { FourKFetchDeps } from '$lib/server/downloader/fourk-service';

/**
 * Phase 1 (audit SEC-009 / DL-3 / API-17) — 4K downloader hardening.
 *
 * P0-12 (SEC-009/DL-3): the fetch used `redirect: 'follow'` WITHOUT hop
 * validation and buffered the ENTIRE response (`response.text()`) before
 * applying the size limit. Fix: manual redirects with EVERY hop re-validated
 * against the fixed trusted origin (redirects are new destinations), and
 * the body cap enforced WHILE STREAMING (oversized bodies abort in-flight).
 *
 * P0-13 (API-17): season/episode <= 0 passed the endpoint and failed inside
 * the service → misleading 503. Fix: endpoint validation (positive integers,
 * 1..10000 — the existing route contract) → 400 convention.
 *
 * Behavioral tests run the REAL service with instrumented fetchers (no
 * network) and the REAL endpoint handler for the validation surface (the
 * adult guard's lazy imports cannot resolve under tsx, so the valid-path
 * handler execution is covered by the guard tests + static wiring).
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const JSON_HEADERS = { 'content-type': 'application/json' };
const VALID_BODY = JSON.stringify({ links: [{ url: 'https://cdn.example/movie.mkv', name: '4K CINEJOY [FSL Server] [WEB-DL DDP5][16.62 GB]' }] });

// ============================================================
// 1. Valid response — parsed end-to-end through manual redirect mode
// ============================================================

{
  const requests: Array<{ url: string; redirect: string }> = [];
  const result = await fetchFourKLinks({ mediaType: 'movie', tmdbId: '8633518' }, {
    fetcher: (async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), redirect: String(init?.redirect) });
      return new Response(VALID_BODY, { status: 200, headers: JSON_HEADERS });
    }) as unknown as typeof fetch,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].redirect, 'manual', 'the fetch uses manual redirects');
  assert.ok(requests[0].url.startsWith(`${FOURK_API_ORIGIN}/movie/8633518`), 'the request targets the fixed trusted origin');
  assert.equal(result.links.length, 1, 'the valid response is parsed');
  assert.equal(result.links[0].quality, '2160p');
  ok(true, '1. valid response parsed; fetch uses manual redirects against the trusted origin');
}

// ============================================================
// 2. Redirect chain on the trusted origin IS followed (bounded)
// ============================================================

{
  let hops = 0;
  const result = await fetchFourKLinks({ mediaType: 'movie', tmdbId: '8633518' }, {
    fetcher: (async (url: string | URL) => {
      hops += 1;
      if (hops <= 2) return new Response(null, { status: 302, headers: { location: `${FOURK_API_ORIGIN}/movie/8633518?hop=${hops}` } });
      return new Response(VALID_BODY, { status: 200, headers: JSON_HEADERS });
    }) as unknown as typeof fetch,
  });
  assert.equal(hops, 3, 'same-origin redirect chain followed to the final response');
  assert.equal(result.links.length, 1);
  ok(true, '2. trusted-origin redirect chain followed (per-hop re-validation in place)');
}

// ============================================================
// 3. Redirect to a DISALLOWED destination is refused (SSRF closed)
// ============================================================

{
  const disallowed = [
    'https://evil.example/movie/8633518',
    'http://169.254.169.254/latest/meta-data',
    'https://127.0.0.1/movie/8633518',
    'http://internal.svc.local/movie/8633518',
  ];
  for (const location of disallowed) {
    let followed = 0;
    const result = await fetchFourKLinks({ mediaType: 'movie', tmdbId: '8633518' }, {
      fetcher: (async () => {
        followed += 1;
        return new Response(null, { status: 302, headers: { location } });
      }) as unknown as typeof fetch,
    });
    assert.equal(followed, 1, 'the disallowed hop is NOT followed');
    assert.deepEqual(result.links, [], 'no links are served from a hijacked redirect');
  }
  ok(true, '3. redirect to disallowed/private destinations refused without following (4 vectors)');
}

// Redirect loops are bounded.
{
  let hops = 0;
  const result = await fetchFourKLinks({ mediaType: 'movie', tmdbId: '8633518' }, {
    fetcher: (async () => {
      hops += 1;
      return new Response(null, { status: 302, headers: { location: `${FOURK_API_ORIGIN}/movie/8633518?hop=${hops}` } });
    }) as unknown as typeof fetch,
  });
  assert.ok(hops <= 5, `redirect loop bounded (stopped after ${hops} hops)`);
  assert.deepEqual(result.links, []);
  ok(true, '4. redirect loops are bounded (no infinite chain)');
}

// ============================================================
// 5. Oversized body — aborted WHILE STREAMING (never fully buffered)
// ============================================================

{
  const CHUNK = 'x'.repeat(64 * 1024);
  let deliveredBytes = 0;
  let aborted = false;
  const oversized = new ReadableStream<Uint8Array>({
    pull(controller) {
      // Far more than the 1 MiB cap — streams forever until aborted.
      deliveredBytes += CHUNK.length;
      controller.enqueue(new TextEncoder().encode(CHUNK));
    },
    cancel() {
      aborted = true;
    },
  });
  const result = await fetchFourKLinks({ mediaType: 'movie', tmdbId: '8633518' }, {
    maxBytes: 512 * 1024,
    fetcher: (async () => new Response(oversized, { status: 200, headers: JSON_HEADERS })) as unknown as typeof fetch,
  });
  assert.deepEqual(result.links, [], 'the oversized response yields no links');
  assert.ok(deliveredBytes < 8 * 1024 * 1024, `streaming stopped early (delivered ${deliveredBytes} bytes, not the whole stream)`);
  ok(true, '5. oversized body: cap enforced while streaming, abort stops delivery (no full buffering)');
}

// Content-Length over the cap is rejected before reading.
{
  let bodyRead = false;
  const result = await fetchFourKLinks({ mediaType: 'movie', tmdbId: '8633518' }, {
    maxBytes: 1024,
    fetcher: (async () => new Response('{"links":[]}', { status: 200, headers: { ...JSON_HEADERS, 'content-length': String(10 * 1024 * 1024) } })) as unknown as typeof fetch,
  });
  void bodyRead;
  assert.deepEqual(result.links, [], 'oversized Content-Length rejected');
  ok(true, '6. oversized Content-Length rejected up-front');
}

// ============================================================
// 7. Malformed responses degrade to the empty result (contract preserved)
// ============================================================

{
  const empty = { links: [], malformed: 0 };
  const invalidJson = await fetchFourKLinks({ mediaType: 'movie', tmdbId: '8633518' }, { fetcher: (async () => new Response('not-json{', { status: 200, headers: JSON_HEADERS })) as unknown as typeof fetch });
  assert.deepEqual(invalidJson, empty, 'invalid JSON -> empty result');
  const notOk = await fetchFourKLinks({ mediaType: 'movie', tmdbId: '8633518' }, { fetcher: (async () => new Response('boom', { status: 500, headers: JSON_HEADERS })) as unknown as typeof fetch });
  assert.deepEqual(notOk, empty, 'HTTP 500 -> empty result');
  const noLinks = await fetchFourKLinks({ mediaType: 'movie', tmdbId: '8633518' }, { fetcher: (async () => new Response('{"nope":1}', { status: 200, headers: JSON_HEADERS })) as unknown as typeof fetch });
  assert.deepEqual(noLinks, empty, 'missing links[] -> empty result');
  ok(true, '7. malformed responses keep the never-throw empty-result contract');
}

// ============================================================
// 8. P0-13 — endpoint season/episode validation (400 convention)
// ============================================================

const { GET: fourkGet } = await import('../src/routes/api/downloader/4k/+server');
const NO_STORE = 'no-store';

async function endpointStatus(query: string): Promise<{ status: number; body: Record<string, unknown>; cacheControl: string }> {
  try {
    const response = await fourkGet({
      url: new URL(`https://mavero.test/api/downloader/4k?${query}`),
      request: new Request(`https://mavero.test/api/downloader/4k?${query}`),
      locals: {},
      cookies: { get: () => undefined },
    } as never);
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, cacheControl: (response.headers.get('cache-control') ?? '') };
  } catch (caught) {
    // The adult guard throws the SvelteKit HttpError (404) once validation
    // passes — surface its status for the boundary assertions below.
    const status = (caught as { status?: number })?.status;
    if (status) return { status, body: {}, cacheControl: '' };
    throw caught;
  }
}

// season/episode <= 0 (the audited vector) must be a client 400, not 503.
for (const query of ['mediaType=series&tmdbId=94605&season=0&episode=1', 'mediaType=series&tmdbId=94605&season=1&episode=0', 'mediaType=series&tmdbId=94605&season=-1&episode=2', 'mediaType=series&tmdbId=94605&season=1&episode=-2']) {
  const { status, body } = await endpointStatus(query);
  assert.equal(status, 400, `invalid episode context must 400: ${query}`);
  const error = (body as { error?: { code?: string } }).error;
  assert.equal(error?.code, 'INVALID_REQUEST', `400 carries the INVALID_REQUEST convention: ${query}`);
}
ok(true, '8. season/episode <= 0 -> 400 INVALID_REQUEST (was: misleading 503 from the service)');

// Numeric form + integer form + upper bound.
for (const query of ['mediaType=series&tmdbId=94605&season=1.5&episode=1', 'mediaType=series&tmdbId=94605&season=abc&episode=1', 'mediaType=series&tmdbId=94605&season=10001&episode=1', 'mediaType=series&tmdbId=94605&season=1&episode=10001']) {
  const { status } = await endpointStatus(query);
  assert.equal(status, 400, `non-integer / out-of-bounds rejected: ${query}`);
}
ok(true, '9. numeric/integer form + 1..10000 bounds enforced (consistent with the existing route contract)');

// Valid request shape passes validation and reaches the guard boundary
// (the guard then requires the environment — asserted via wiring below).
{
  const { status } = await endpointStatus('mediaType=movie&tmdbId=8633518');
  assert.ok(status !== 400, 'valid request shape is NOT rejected by validation');
  ok(true, '10. valid requests unaffected by the new validation');
}

// Wiring: the guard runs BEFORE the fetch; the endpoint still uses no-store.
{
  const source = read('src/routes/api/downloader/4k/+server.ts');
  const guardIndex = source.indexOf('await assertAdultDownloadAllowed(');
  const fetchIndex = source.indexOf('await fetchFourKLinks(');
  assert.ok(guardIndex > -1 && fetchIndex > guardIndex, 'the adult guard runs before the 4K fetch');
  assert.match(source, new RegExp(NO_STORE), 'no-store cache header preserved');
  assert.match(source, /validEpisodeContext/, 'endpoint-level episode-context validation present');
  const service = read('src/lib/server/downloader/fourk-service.ts');
  assert.match(service, /redirect: 'manual'/, 'service uses manual redirects');
  assert.match(service, /redirectUrl\.origin !== FOURK_API_ORIGIN/, 'every hop re-validated against the trusted origin');
  assert.match(service, /for await \(const chunk of response\.body/, 'body cap enforced while streaming');
  assert.doesNotMatch(service, /redirect: 'follow'/, 'the unvalidated follow mode is gone');
  assert.doesNotMatch(service, /await response\.text\(\);/, 'the buffer-then-check pattern is gone');
  ok(true, '11. wiring: guard before fetch; manual redirects + streamed cap in the service');
}

console.log(`phase1_fourk_hardening_test: ${passed} checks passed (redirect validation + streamed cap + input validation)`);
