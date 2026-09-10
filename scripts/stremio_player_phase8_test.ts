import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  createConnectTimeLookup,
  ssrfSafeAgent,
  ssrfSafeFetch,
  type ConnectAddressValidator,
} from '$lib/server/streaming/stremio/connect-guard';
import {
  assertSafeManifestDestination,
  assertSafeManifestUrl,
  isBlockedIpAddress,
} from '$lib/server/streaming/stremio/ssrf';
import { fetchStremioManifest } from '$lib/server/streaming/stremio/manifest-fetch';
import { fetchStremioStreamResponse } from '$lib/server/streaming/stremio/stream-fetch';
import {
  MANIFEST_CACHE_MAX_ENTRIES,
  createManifestCache,
  defaultManifestCache,
  manifestCacheKey,
} from '$lib/server/streaming/stremio/manifest-cache';
import {
  buildFailedManifestUpdate,
  fetchNormalizedManifest,
  sanitizeLastError,
} from '$lib/server/streaming/stremio/manifest-service';
import { supportsStreamResource, validateStremioManifest } from '$lib/server/streaming/stremio/manifest-normalize';
import {
  MAX_STREAM_ENTRIES,
  normalizeStremioStreamResponse,
  STREAM_URL_MAX_LENGTH,
} from '$lib/server/streaming/stremio/stream-normalize';
import {
  STREAM_RESOLUTION_CONCURRENCY,
  resolveStremioStreams,
} from '$lib/server/streaming/stremio/stream-resolver';
import { ManifestServiceError } from '$lib/server/streaming/stremio/errors';
import { StreamServiceError } from '$lib/server/streaming/stremio/stream-errors';
import {
  asManifestServiceError,
  isPermanentManifestFailure,
} from '$lib/server/streaming/stremio/errors';
import { buildStremioStreamUrl } from '$lib/server/streaming/stremio/stream-ids';
import { StreamingValidationError } from '$lib/server/streaming/validation';
import {
  moveAddon,
  deleteAddonById,
} from '$lib/server/streaming/stremio/admin-addons';
import type { StreamingAddon } from '$lib/shared/streaming-addons';
import { MAVERO_PLAYER_SOURCE_ID } from '$lib/shared/mavero-player';
import { classifyAdminMutationError } from '$lib/server/streaming/mutation-result';
import { readdirSync, statSync } from 'node:fs';

function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) out.push(...walkSources(full));
    else out.push(full);
  }
  return out;
}

// Phase 8: production hardening & final audit tests for the MAVERO Stremio
// HTTP addon integration.
//
// Scope (sections A–U):
//   A  baseline & dependency pins          L  admin mutation authz re-pins
//   B  connect-time lookup unit contract   M  admin ordering integrity
//   C  connect-time guard REAL sockets     N  manifest cache bounds
//   D  D1 wiring — manifest fetcher        O  XSS / rendering pins
//   E  D1 wiring — stream fetcher          P  user/admin isolation & RLS
//   F  D2 — manifestCacheKey               Q  HLS engine pins
//   G  D2 — fetchNormalizedManifest cache  R  error hygiene / no leakage
//   H  SSRF guard regression re-pins       S  URL/stream security invariants
//   I  manifest parser hardening           T  logging & dependency hygiene
//   J  stream normalize invariants         U  Phase 8 scope & integrity
//   K  resolver aggregate re-pins
//
// D1 = DNS-rebinding TOCTOU closure (connect-time validation, undici Agent).
// D2 = manifest-cache malformed-URL handling (typed INVALID_URL + validate
//      before any cache interaction).
//
// Behavioral tests use injected fakes or REAL loopback sockets ONLY — no
// test touches the real internet. Security invariants are pinned with
// static source assertions per the established repo test philosophy.

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

async function rejects(action: () => Promise<unknown>, check: (error: unknown) => boolean, label: string) {
  try {
    await action();
    assert.fail(`${label}: expected rejection`);
  } catch (error) {
    assert.ok(check(error), `${label}: unexpected error ${String(error)}`);
  }
  passed += 1;
}

function throws(action: () => unknown, check: (error: unknown) => boolean, label: string) {
  try {
    action();
    assert.fail(`${label}: expected throw`);
  } catch (error) {
    assert.ok(check(error), `${label}: unexpected error ${String(error)}`);
  }
  passed += 1;
}

const isManifestError = (error: unknown): error is ManifestServiceError => error instanceof ManifestServiceError;
const isManifestCode = (code: string) => (error: unknown) => isManifestError(error) && error.code === code;
const isStreamCode = (code: string) => (error: unknown) => error instanceof StreamServiceError && error.code === code;
const notTypeError = (error: unknown) => !(error instanceof TypeError);

function readRepoFile(relative: string): string {
  return readFileSync(path.resolve(relative), 'utf8');
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// Fakes — no test ever hits the real internet or a real database
// ---------------------------------------------------------------------------

const PUBLIC_V4 = { address: '93.184.216.34', family: 4 } as const;
const PUBLIC_V6 = { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 } as const;
const publicResolver = async () => [PUBLIC_V4];

type RouteHandler = () => Response;

function createFetcher(routes: Record<string, RouteHandler>, calls: Array<{ url: string }>): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    calls.push({ url });
    const handler = routes[url] ?? routes['*'];
    if (!handler) return new Response('not found', { status: 404 });
    return handler();
  }) as typeof fetch;
}

function manifestBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'community.example',
    version: '1.2.3',
    name: 'Example Addon',
    description: 'An example HTTP addon',
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    resources: [{ name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] }],
    ...overrides,
  });
}

const MANIFEST_URL = 'https://cdn.example.com/manifest.json';

function jsonManifestRoute(body: string = manifestBody()): RouteHandler {
  return () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

// ===========================================================================
// A. Baseline & dependency pins
// ===========================================================================
{
  const pkg = JSON.parse(readRepoFile('package.json'));
  ok(pkg.dependencies['hls.js'] === '1.7.2', 'A: hls.js stays pinned to exactly 1.7.2 (no range)');
  ok(pkg.dependencies['undici'] === '^8.10.2', 'A: undici ^8.10.2 is the only new dependency');
  const installedUndici = JSON.parse(readRepoFile('node_modules/undici/package.json'));
  ok(installedUndici.version === '8.10.2', 'A: installed undici resolves to 8.10.2');

  const depNames = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(' ').toLowerCase();
  ok(!/torrent|bittorrent|webtorrent|debrid|magnet|peerflix|p2p/.test(depNames), 'A: no P2P/torrent/debrid dependencies exist');

  const testScript: string = pkg.scripts.test;
  // Phase 9 appended the stremio_player_phase9_test.ts suite after Phase 8
  // — the chain still runs phase 7 before phase 8, and now ENDS with phase 9.
  ok(
    testScript.indexOf('stremio_player_phase7_test.ts') !== -1 &&
      testScript.indexOf('stremio_player_phase7_test.ts') < testScript.indexOf('stremio_player_phase8_test.ts') &&
      testScript.indexOf('stremio_player_phase8_test.ts') < testScript.indexOf('stremio_player_phase9_test.ts') &&
      testScript.trimEnd().endsWith('stremio_player_phase9_test.ts'),
    'A: test chain runs phase 8 after phase 7 and ends with the Phase 9 suite (Phase 9 extension)',
  );

  const netlifyToml = readRepoFile('netlify.toml');
  ok(/NODE_VERSION\s*=\s*"22"/.test(netlifyToml), 'A: netlify runtime is Node 22');
  const undiciEngines: string = installedUndici.engines?.node ?? '';
  const undiciMajor = Number.parseInt(undiciEngines.replace(/[^0-9]/g, '').slice(0, 2), 10);
  ok(undiciMajor === 22, 'A: undici 8.10.2 floor (>=22.19) is satisfied by the Node 22 runtime');

  ok(
    netlifyToml.includes('Strict-Transport-Security') &&
      netlifyToml.includes('X-Content-Type-Options') &&
      netlifyToml.includes('X-Frame-Options'),
    'A: existing security headers (HSTS, nosniff, frame-deny) are untouched',
  );

  const importingFiles = [
    'src/lib/server/streaming/stremio/manifest-fetch.ts',
    'src/lib/server/streaming/stremio/stream-fetch.ts',
  ].filter((file) => readRepoFile(file).includes("from './connect-guard'"));
  ok(importingFiles.length === 2, 'A: connect-guard is imported only by the two addon pipeline fetchers (server-only)');
}

// ===========================================================================
// B. Connect-time lookup — unit contract (fake resolvers)
// ===========================================================================
{
  type LookupResult = { err: Error | null; address: unknown; family: unknown; calls: number };
  function runLookup(lookup: ReturnType<typeof createConnectTimeLookup>, hostname: string, options: { all?: boolean; family?: number }): Promise<LookupResult> {
    return new Promise((resolve) => {
      let calls = 0;
      lookup(hostname, options, (err, address, family) => {
        calls += 1;
        resolve({ err, address, family, calls });
      });
    });
  }
  const permissive: ConnectAddressValidator = () => false;
  const lookupWith = (resolver: (host: string) => Promise<Array<{ address: string; family: number }>>, validator: ConnectAddressValidator = isBlockedIpAddress) =>
    createConnectTimeLookup(resolver, validator);

  const both = [PUBLIC_V4, PUBLIC_V6];

  const allResult = await runLookup(lookupWith(async () => both), 'addons.example', { all: true });
  ok(!allResult.err && Array.isArray(allResult.address) && allResult.address.length === 2, 'B: all-shape callback delivers every validated address');
  ok(
    !allResult.err && Array.isArray(allResult.address) && allResult.address[0].address === PUBLIC_V4.address && allResult.address[1].address === PUBLIC_V6.address,
    'B: verbatim resolver ordering is preserved (no reordering)',
  );

  const single = await runLookup(lookupWith(async () => both), 'addons.example', { all: false });
  ok(!single.err && single.address === PUBLIC_V4.address && single.family === 4, 'B: single-shape callback delivers (address, family)');

  const mixed = await runLookup(lookupWith(async () => [PUBLIC_V4, { address: '10.0.0.5', family: 4 }]), 'rebind.example', { all: true });
  ok(!!mixed.err && (mixed.address === undefined || mixed.address === ''), 'B: ANY blocked address among public answers fails the whole lookup (mixed-DNS rebinding policy, no usable address delivered)');

  const blockedOnly = await runLookup(lookupWith(async () => [{ address: '192.168.1.10', family: 4 }]), 'rebind.example', { all: true });
  ok(!!blockedOnly.err, 'B: fully-private resolution fails closed');

  const empty = await runLookup(lookupWith(async () => []), 'empty.example', { all: true });
  ok(!!empty.err, 'B: empty resolution fails closed');

  const rejecting = await runLookup(lookupWith(async () => {
    throw new Error('dns down');
  }), 'down.example', { all: true });
  ok(!!rejecting.err, 'B: resolver rejection becomes a lookup error (never an unhandled rejection)');

  const syncThrow = await runLookup(lookupWith(() => {
    throw new Error('sync');
  }), 'sync.example', { all: true });
  ok(!!syncThrow.err, 'B: synchronously throwing resolver fails closed');

  const v6Missing = await runLookup(lookupWith(async () => [PUBLIC_V4]), 'v4.example', { all: true, family: 6 });
  ok(!!v6Missing.err, 'B: requested family with no matching answer fails closed');

  const v6Filtered = await runLookup(lookupWith(async () => both), 'dual.example', { all: true, family: 6 });
  ok(
    !v6Filtered.err && Array.isArray(v6Filtered.address) && v6Filtered.address.length === 1 && v6Filtered.address[0].family === 6,
    'B: family filter keeps only matching validated addresses',
  );

  const permissiveResult = await runLookup(lookupWith(async () => [{ address: '10.1.2.3', family: 4 }], permissive), 'inj.example', { all: false });
  ok(!permissiveResult.err && permissiveResult.address === '10.1.2.3', 'B: validator is injectable (test hook), success path delivers the address');

  const doubleBlocked = await runLookup(lookupWith(async () => [{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.1', family: 4 }]), 'multi.example', { all: true });
  ok(!!doubleBlocked.err && doubleBlocked.calls === 1, 'B: lookup settles exactly once (no double callback)');

  ok(typeof createConnectTimeLookup() === 'function' && typeof ssrfSafeAgent.dispatch === 'function', 'B: production lookup/agent construct with defaults (system resolver + real validator)');
}

// ===========================================================================
// C. Connect-time guard — REAL loopback sockets (undici dispatcher contract)
// ===========================================================================
{
  const hits = { count: 0 };
  const server = http.createServer((req, res) => {
    hits.count += 1;
    if (req.url === '/redirect302') {
      res.writeHead(302, { location: '/final', 'content-type': 'text/plain' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://localhost:${port}`;

  try {
    // A test dispatcher built from the SAME production lookup code, with an
    // injectable permissive validator + resolver pinning every name to the
    // loopback address (the production validator would block loopback).
    const resolverCalls = { count: 0 };
    const testAgent = new Agent({
      connect: {
        lookup: createConnectTimeLookup(
          async () => {
            resolverCalls.count += 1;
            return [{ address: '127.0.0.1', family: 4 }];
          },
          () => false,
        ),
      },
    });

    const okResponse = await undiciFetch(`${base}/data`, { dispatcher: testAgent });
    const body = await okResponse.text();
    ok(okResponse.status === 200 && body.includes('"ok":true'), 'C: request through production lookup code reaches the server (dispatcher contract works)');
    ok(resolverCalls.count >= 1, 'C: the custom connect-time lookup is actually invoked by the dispatcher');

    // THE D1 PROOF: the production singleton agent + REAL OS resolution
    // (localhost -> 127.0.0.1) + REAL validator must fail closed with ZERO
    // requests reaching the server.
    const hitsBefore = hits.count;
    let blockedError: unknown = undefined;
    try {
      await ssrfSafeFetch(`${base}/data`);
    } catch (error) {
      blockedError = error;
    }
    ok(!!blockedError, 'C: ssrfSafeFetch fails closed for a loopback destination (production agent)');
    ok(hits.count === hitsBefore, 'C: ZERO requests reached the loopback server (no socket was ever opened)');

    // Blocked-validator agent: fail closed, no server hit.
    const hitsBeforeBlocked = hits.count;
    const blockedAgent = new Agent({
      connect: { lookup: createConnectTimeLookup(async () => [{ address: '127.0.0.1', family: 4 }], isBlockedIpAddress) },
    });
    let blockedAgentError: unknown = undefined;
    try {
      await undiciFetch(`${base}/data`, { dispatcher: blockedAgent });
    } catch (error) {
      blockedAgentError = error;
    }
    ok(!!blockedAgentError && hits.count === hitsBeforeBlocked, 'C: blocked validator => error callback => no connection attempt');
    await blockedAgent.close().catch(() => {});

    // Sync-throwing validator: fails closed without crashing the process.
    const throwAgent = new Agent({
      connect: {
        lookup: createConnectTimeLookup((() => {
          throw new Error('sync boom');
        }) as never, () => false),
      },
    });
    let threw = false;
    try {
      await undiciFetch(`${base}/data`, { dispatcher: throwAgent });
    } catch {
      threw = true;
    }
    ok(threw, 'C: sync-throwing resolver inside the lookup fails closed, process alive');
    await throwAgent.close().catch(() => {});

    // redirect:'manual' contract holds through the custom dispatcher (the
    // fetcher redirect loops rely on inspectable 3xx responses).
    const res302 = await undiciFetch(`${base}/redirect302`, { redirect: 'manual', dispatcher: testAgent });
    ok(res302.status === 302 && res302.headers.get('location') === '/final', 'C: redirect manual exposes the 3xx + location through the dispatcher');

    // Abort propagation through the custom dispatcher.
    const hang = http.createServer(() => {});
    await new Promise<void>((resolve) => hang.listen(0, '127.0.0.1', resolve));
    const hangPort = (hang.address() as { port: number }).port;
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 150);
    let aborted = false;
    try {
      await undiciFetch(`http://localhost:${hangPort}/x`, { signal: abortController.signal, dispatcher: testAgent });
    } catch {
      aborted = true;
    }
    ok(aborted, 'C: abort signal propagates through the custom dispatcher');
    hang.close();

    // Pool stability: sequential requests through the same agent keep working.
    const second = await undiciFetch(`${base}/data`, { dispatcher: testAgent });
    ok(second.status === 200, 'C: sequential requests through the same agent stay healthy');
    await testAgent.close().catch(() => {});
  } finally {
    server.close();
  }
}

// ===========================================================================
// D. D1 wiring — manifest fetcher
// ===========================================================================
{
  const source = readRepoFile('src/lib/server/streaming/stremio/manifest-fetch.ts');
  ok(source.includes('deps.fetcher ?? ssrfSafeFetch'), 'D: manifest fetcher defaults to the SSRF-safe dispatcher fetcher');
  ok(countOccurrences(source, 'assertSafeManifestUrl(') >= 2 && countOccurrences(source, 'assertSafeManifestDestination(') >= 2, 'D: manifest fetcher validates the initial URL AND every redirect hop');
  const ssrfSource = readRepoFile('src/lib/server/streaming/stremio/ssrf.ts');
  ok(ssrfSource.includes('CLOSED in Phase 8') && ssrfSource.includes('connect-guard.ts'), 'D: ssrf.ts documents the TOCTOU closure instead of the residual risk');

  // Gate 1 (pre-flight) still runs first: localhost + loopback literals are
  // rejected BEFORE any fetch — with the default (dispatcher) fetcher active.
  await rejects(
    () => fetchStremioManifest(`http://localhost:${41234}/manifest.json`, { dnsResolver: publicResolver }),
    isManifestCode('BLOCKED_URL'),
    'D: pre-flight hostname blocklist fires before any connection (default fetcher active)',
  );
  await rejects(
    () => fetchStremioManifest(`http://127.0.0.1:${41234}/manifest.json`, { dnsResolver: publicResolver }),
    isManifestCode('BLOCKED_URL'),
    'D: pre-flight IP-literal guard fires before any connection (default fetcher active)',
  );

  // Injected fetchers are still honored verbatim (tests, and the existing
  // Phase 2 suite contract).
  const calls: Array<{ url: string }> = [];
  const result = await fetchStremioManifest(MANIFEST_URL, {
    fetcher: createFetcher({ [MANIFEST_URL]: jsonManifestRoute() }, calls),
    dnsResolver: publicResolver,
  });
  ok(calls.length === 1 && calls[0].url === MANIFEST_URL, 'D: injected fetcher is used verbatim (no dispatcher interference)');
  ok(result.finalUrl === MANIFEST_URL, 'D: success result carries the final URL');
  ok((result.body as { id: string }).id === 'community.example', 'D: success result carries the parsed manifest body');
}

// ===========================================================================
// E. D1 wiring — stream fetcher
// ===========================================================================
{
  const source = readRepoFile('src/lib/server/streaming/stremio/stream-fetch.ts');
  ok(source.includes('deps.fetcher ?? ssrfSafeFetch'), 'E: stream fetcher defaults to the SSRF-safe dispatcher fetcher');
  ok(countOccurrences(source, 'assertSafeManifestUrl(') >= 2 && countOccurrences(source, 'assertSafeManifestDestination(') >= 2, 'E: stream fetcher validates the initial URL AND every redirect hop');

  await rejects(
    () => fetchStremioStreamResponse(`http://localhost:${41234}/stream/movie/tt123.json`, { dnsResolver: publicResolver }),
    isStreamCode('BLOCKED_URL'),
    'E: pre-flight hostname blocklist fires before any connection (default fetcher active)',
  );

  const streamUrl = 'https://s.example/stream/movie/tt123.json';
  const calls: Array<{ url: string }> = [];
  const parsed = (await fetchStremioStreamResponse(streamUrl, {
    fetcher: createFetcher({ [streamUrl]: () => new Response(JSON.stringify({ streams: [] }), { status: 200, headers: { 'content-type': 'application/json' } }) }, calls),
    dnsResolver: publicResolver,
  })) as { streams: unknown[] };
  ok(calls.length === 1 && Array.isArray(parsed.streams), 'E: injected fetcher honored; stream JSON parsed');

  // Redirect hops are re-validated (manual redirect loop, bounded).
  const redirectCalls: Array<{ url: string }> = [];
  const redirectParsed = (await fetchStremioStreamResponse(streamUrl, {
    fetcher: createFetcher(
      {
        [streamUrl]: () => new Response(null, { status: 302, headers: { location: '/stream/movie/tt123.json?hop=2' } }),
        'https://s.example/stream/movie/tt123.json?hop=2': () => new Response(JSON.stringify({ streams: [{ url: 'https://cdn.example/video.mp4' }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
      },
      redirectCalls,
    ),
    dnsResolver: publicResolver,
  })) as { streams: Array<{ url: string }> };
  ok(redirectCalls.length === 2 && redirectParsed.streams[0]?.url === 'https://cdn.example/video.mp4', 'E: bounded redirect loop re-validates and follows hops');
}

// ===========================================================================
// F. D2 — manifestCacheKey malformed-URL handling
// ===========================================================================
{
  ok(manifestCacheKey('HTTPS://ADDONS.EXAMPLE/manifest.json') === 'https://addons.example/manifest.json', 'F: valid URLs still canonicalize identically (Phase 2 behavior preserved)');

  throws(() => manifestCacheKey('not a url'), (error) => isManifestError(error) && error.code === 'INVALID_URL' && notTypeError(error), 'F: malformed URL throws typed INVALID_URL (no raw TypeError)');
  throws(() => manifestCacheKey(':'), (error) => isManifestError(error) && error.code === 'INVALID_URL', 'F: degenerate URL throws typed INVALID_URL');
  throws(() => manifestCacheKey('http://'), (error) => isManifestError(error) && error.code === 'INVALID_URL', 'F: scheme-only URL throws typed INVALID_URL');
  throws(() => manifestCacheKey('   '), (error) => isManifestError(error) && error.code === 'INVALID_URL', 'F: whitespace-only URL throws typed INVALID_URL');

  ok(manifestCacheKey('  https://x.example/m.json  ') === 'https://x.example/m.json', 'F: surrounding whitespace is still trimmed for valid URLs');
}

// ===========================================================================
// G. D2 — fetchNormalizedManifest cache path
// ===========================================================================
{
  const calls: Array<{ url: string }> = [];

  // Malformed URL + cache enabled: typed INVALID_URL, fetcher never called,
  // cache untouched. (Before Phase 8 this escaped as an untyped TypeError
  // from the key builder and classified as a temporary UNEXPECTED failure.)
  const cacheA = createManifestCache();
  await rejects(
    () => fetchNormalizedManifest('not a url', { useCache: true, cache: cacheA, fetcher: createFetcher({}, calls), dnsResolver: publicResolver }),
    isManifestCode('INVALID_URL'),
    'G: cache path surfaces the typed INVALID_URL for malformed URLs',
  );
  ok(calls.length === 0 && cacheA.size() === 0, 'G: malformed URL performs no fetch and writes nothing to the cache');

  // Blocked destination + cache enabled: typed BLOCKED_URL before any cache
  // or network interaction.
  const cacheB = createManifestCache();
  await rejects(
    () => fetchNormalizedManifest('http://10.0.0.9/manifest.json', { useCache: true, cache: cacheB, fetcher: createFetcher({}, calls), dnsResolver: publicResolver }),
    isManifestCode('BLOCKED_URL'),
    'G: cache path surfaces the typed BLOCKED_URL for blocked destinations',
  );
  ok(calls.length === 0 && cacheB.size() === 0, 'G: blocked URL performs no fetch and writes nothing to the cache');

  // Valid URL + cache enabled: fetch once, hit the cache afterwards, and key
  // by the canonical URL across spelling variants.
  const cacheC = createManifestCache();
  const fetcherC = createFetcher({ 'https://addons.example/m.json': jsonManifestRoute() }, calls);
  const first = await fetchNormalizedManifest('HTTPS://ADDONS.EXAMPLE/m.json', { useCache: true, cache: cacheC, fetcher: fetcherC, dnsResolver: publicResolver });
  ok(first.manifest.name === 'Example Addon', 'G: valid cache-path fetch returns the normalized manifest');
  const second = await fetchNormalizedManifest('https://addons.example/m.json', { useCache: true, cache: cacheC, fetcher: fetcherC, dnsResolver: publicResolver });
  ok(calls.length === 1 && second.manifest.name === 'Example Addon', 'G: second request is served from the cache (bounded, typed pipeline intact)');
  ok(cacheC.get(manifestCacheKey('https://addons.example/m.json')) !== undefined, 'G: cache key is the canonical URL (case-variant spellings share one entry)');

  // Non-cache path unchanged: typed INVALID_URL, default cache untouched.
  await rejects(
    () => fetchNormalizedManifest('not a url', { fetcher: createFetcher({}, calls), dnsResolver: publicResolver }),
    isManifestCode('INVALID_URL'),
    'G: non-cache path keeps the typed INVALID_URL',
  );
  ok(defaultManifestCache.size() === 0, 'G: module default cache stays empty (no accidental pollution)');

  // The D2 error class is PERMANENT — persisted outcome flips status to
  // `unavailable` with only the curated message.
  const now = '2026-09-11T00:00:00.000Z';
  const failureUpdate = buildFailedManifestUpdate(new ManifestServiceError('INVALID_URL'), now);
  ok(failureUpdate.status === 'unavailable' && failureUpdate.last_error === 'The addon manifest URL is not a valid URL.', 'G: INVALID_URL is classified permanent and persists only the curated message');
  ok(isPermanentManifestFailure(new ManifestServiceError('BLOCKED_URL')), 'G: BLOCKED_URL is classified permanent');
}

// ===========================================================================
// H. SSRF guard regression re-pins (Phase 2 surface intact behind D1)
// ===========================================================================
{
  throws(() => assertSafeManifestUrl('javascript:alert(1)'), isManifestCode('INVALID_URL'), 'H: javascript: rejected');
  throws(() => assertSafeManifestUrl('data:text/html,hi'), isManifestCode('INVALID_URL'), 'H: data: rejected');
  throws(() => assertSafeManifestUrl('file:///etc/passwd'), isManifestCode('INVALID_URL'), 'H: file: rejected');
  throws(() => assertSafeManifestUrl('http://127.1/'), isManifestCode('BLOCKED_URL'), 'H: compact IPv4 literal (127.1) blocked');
  throws(() => assertSafeManifestUrl('http://0x7f000001/'), isManifestCode('BLOCKED_URL'), 'H: hex IPv4 literal blocked');
  throws(() => assertSafeManifestUrl('http://[::1]/'), isManifestCode('BLOCKED_URL'), 'H: IPv6 loopback blocked');
  throws(() => assertSafeManifestUrl('http://[::ffff:127.0.0.1]/'), isManifestCode('BLOCKED_URL'), 'H: IPv4-mapped IPv6 blocked');
  throws(() => assertSafeManifestUrl('http://metadata.google.internal/'), isManifestCode('BLOCKED_URL'), 'H: cloud metadata hostname blocked');

  await rejects(() => assertSafeManifestDestination(new URL('http://rebind.example/'), async () => [{ address: '10.9.8.7', family: 4 }]), isManifestCode('BLOCKED_URL'), 'H: DNS name resolving private is blocked (pre-flight)');
  await assertSafeManifestDestination(new URL('http://public.example/'), publicResolver);
  passed += 1;
}

// ===========================================================================
// I. Manifest parser hardening re-pins
// ===========================================================================
{
  throws(() => validateStremioManifest(null), isManifestCode('INVALID_MANIFEST'), 'I: null body rejected');
  throws(() => validateStremioManifest([1, 2, 3]), isManifestCode('INVALID_MANIFEST'), 'I: array body rejected');
  throws(() => validateStremioManifest({ id: 'x', name: 'N' }), isManifestCode('INVALID_MANIFEST'), 'I: manifest missing required fields rejected');
  throws(() => validateStremioManifest({ id: 'x', version: '1.0.0', name: 'N', types: ['movie'], resources: [] }), isManifestCode('UNSUPPORTED_MANIFEST'), 'I: explicitly empty resources rejected as unsupported');
  const torrentOnly = validateStremioManifest({ id: 'x', version: '1.0.0', name: 'N', types: ['movie'], resources: [{ name: 'torrent' }] }) as { resources: string[] };
  ok(!supportsStreamResource(torrentOnly as never), 'I: torrent-only manifest never satisfies the explicit stream capability');
  const defaults = validateStremioManifest({ id: 'x', version: '1.0.0', name: 'N', types: ['movie'] }) as { resources: string[] };
  ok(!supportsStreamResource(defaults as never), 'I: missing resources field never implies stream support (defaults are non-playable)');

  // Prototype-pollution-shaped JSON must not crash the parser or pollute.
  const hostile = JSON.parse('{"__proto__":{"polluted":1},"id":"x","version":"1.0.0","name":"N","types":["movie"],"resources":[{"name":"stream"}]}');
  const parsedHostile = validateStremioManifest(hostile);
  ok((parsedHostile as { name: string }).name === 'N' && ({} as Record<string, unknown>).polluted === undefined, 'I: __proto__-shaped manifest parsed safely, no prototype pollution');

  const hostileName = validateStremioManifest({ id: 'x', version: '1.0.0', name: '<script>alert(1)</script>', description: 'ok', types: ['movie'], resources: [{ name: 'stream' }] }) as { name: string };
  ok(hostileName.name.includes('<script>'), 'I: hostile metadata is carried as inert data (render layer escapes it — see section O)');
  throws(
    () => validateStremioManifest({ id: 'x', version: '1.0.0', name: 'N', description: 'x'.repeat(5000), types: ['movie'], resources: [{ name: 'stream' }] }),
    isManifestCode('INVALID_MANIFEST'),
    'I: oversized text fields are rejected with the typed error (bounded parser, no crash)',
  );
}

// ===========================================================================
// J. Stream normalize invariants re-pins
// ===========================================================================
{
  function streamsOf(entries: Array<Record<string, unknown>>): { playable: Array<Record<string, unknown>>; all: unknown } {
    const response = normalizeStremioStreamResponse({ streams: entries });
    return { playable: (response as { streams: Array<Record<string, unknown>> }).streams, all: response };
  }

  const jsResult = streamsOf([{ url: 'javascript:alert(1)', title: 'js' }]);
  ok(jsResult.playable.length === 0, 'J: javascript: stream URL never becomes playable');

  const magnet = streamsOf([{ url: 'magnet:?xt=urn:btih:abcdef', title: 'magnet' }]);
  ok(magnet.playable.length === 0, 'J: magnet: stream URL never becomes playable');

  const torrentish = streamsOf([{ url: 'https://x.example/video.mp4', infoHash: 'abcdef1234567890', title: 'torrent' }]);
  ok(torrentish.playable.length === 0, 'J: infoHash (torrent signal) stream excluded');

  const externalOnly = streamsOf([{ externalUrl: 'https://open.example/video', title: 'ext' }]);
  ok(externalOnly.playable.length === 0, 'J: externalUrl-only entry is never playable media');

  const protocols = streamsOf([
    { url: 'https://x.example/hls.m3u8', title: 'a' },
    { url: 'https://x.example/video.mp4', title: 'b' },
  ]);
  ok(
    protocols.playable.length === 2 && protocols.playable.some((s) => (s as { protocol: string }).protocol === 'hls') && protocols.playable.some((s) => (s as { protocol: string }).protocol === 'mp4'),
    'J: http(s) streams normalized with per-stream protocol (hls/mp4)',
  );

  const many = streamsOf(Array.from({ length: 250 }, (_, i) => ({ url: `https://x.example/v${i}.mp4` })));
  ok(many.playable.length <= MAX_STREAM_ENTRIES, 'J: stream list is capped (MAX_STREAM_ENTRIES)');

  const longUrl = streamsOf([{ url: `https://x.example/v?pad=${'a'.repeat(STREAM_URL_MAX_LENGTH)}` }]);
  ok(longUrl.playable.length === 0, 'J: oversized stream URL excluded');
}

// ===========================================================================
// K. Resolver aggregate re-pins
// ===========================================================================
{
  function addonFixture(overrides: Partial<StreamingAddon> & { id: string; manifestUrl: string }): StreamingAddon {
    return {
      name: `Addon ${overrides.id}`,
      slug: `addon-${overrides.id}`,
      enabled: true,
      status: 'experimental',
      ordering: 0,
      supportedTypes: ['movie'],
      idPrefixes: ['tt'],
      resources: ['stream'],
      capabilities: { supportsStream: true },
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
      ...overrides,
    };
  }
  const request = { mediaType: 'movie' as const, identifiers: { imdbId: 'tt123', tmdbId: null } };
  const endpointOf = (manifestUrl: string) => buildStremioStreamUrl(manifestUrl, 'movie', 'tt123')!;

  // Deterministic ordering follows the loader contract (DB: ordering → name).
  const first = addonFixture({ id: 'a', manifestUrl: 'https://a.example/manifest.json', ordering: 0 });
  const second = addonFixture({ id: 'b', manifestUrl: 'https://b.example/manifest.json', ordering: 2 });
  const orderingRoutes: Record<string, RouteHandler> = {
    [endpointOf('https://a.example/manifest.json')]: () => new Response(JSON.stringify({ streams: [{ url: 'https://cdn.example/a.mp4' }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    [endpointOf('https://b.example/manifest.json')]: () => new Response(JSON.stringify({ streams: [{ url: 'https://cdn.example/b.mp4' }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  };
  const orderedCalls: Array<{ url: string }> = [];
  const ordered = await resolveStremioStreams({} as never, request, {
    loadAddons: async () => [first, second],
    fetcher: createFetcher(orderingRoutes, orderedCalls),
    dnsResolver: publicResolver,
  });
  ok(ordered.sources.length === 2 && ordered.sources[0].url === 'https://cdn.example/a.mp4', 'K: sources follow deterministic loader order (ordering → name)');
  const resolverSource = readRepoFile('src/lib/server/streaming/stremio/stream-resolver.ts');
  ok(resolverSource.includes(".order('ordering'") && resolverSource.includes(".order('name'"), 'K: default loader orders by (ordering, name) in SQL');

  // Failure isolation: one failing addon never removes the other's streams.
  const isolated = await resolveStremioStreams({} as never, request, {
    loadAddons: async () => [first, second],
    fetcher: createFetcher(
      {
        [endpointOf('https://a.example/manifest.json')]: () => new Response('boom', { status: 500 }),
        [endpointOf('https://b.example/manifest.json')]: () => new Response(JSON.stringify({ streams: [{ url: 'https://cdn.example/b.mp4' }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
      },
      [],
    ),
    dnsResolver: publicResolver,
  });
  ok(isolated.sources.length === 1 && isolated.sources[0].url === 'https://cdn.example/b.mp4', 'K: per-addon failure is isolated; healthy addon still resolves');

  // Bounded concurrency: in-flight requests never exceed the cap.
  let inFlight = 0;
  let maxInFlight = 0;
  const sixAddons = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => addonFixture({ id, manifestUrl: `https://${id}.example/manifest.json`, ordering: i }));
  const concRoutes: Record<string, RouteHandler> = {};
  for (const a of sixAddons) {
    concRoutes[endpointOf(a.manifestUrl)] = () =>
      new Promise<Response>((resolve) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        setTimeout(() => {
          inFlight -= 1;
          resolve(new Response(JSON.stringify({ streams: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
        }, 25);
      });
  }
  const concurrencyDeps = { loadAddons: async () => sixAddons, fetcher: createFetcher(concRoutes, []), dnsResolver: publicResolver, concurrency: 2 };
  await resolveStremioStreams({} as never, request, concurrencyDeps);
  ok(maxInFlight <= 2, 'K: bounded concurrency respected (max in-flight <= cap)');

  // Aggregate budget: a hanging addon is cut off by the overall deadline.
  // The fake fetcher is signal-aware (like real fetch) so the abort actually
  // interrupts the in-flight request.
  const hangFetcher = (async (input: string | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => reject(new Error('aborted'));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }) as typeof fetch;
  const hung = await resolveStremioStreams({} as never, request, {
    loadAddons: async () => [first],
    fetcher: hangFetcher,
    dnsResolver: publicResolver,
    overallTimeoutMs: 120,
  });
  ok(hung.sources.length === 0, 'K: overall resolution budget aborts hanging addons (never hangs the request)');

  // URL-identity dedupe: the same stream from two addons yields one source.
  const deduped = await resolveStremioStreams({} as never, request, {
    loadAddons: async () => [first, second],
    fetcher: createFetcher(
      {
        [endpointOf('https://a.example/manifest.json')]: () => new Response(JSON.stringify({ streams: [{ url: 'https://cdn.example/same.mp4' }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
        [endpointOf('https://b.example/manifest.json')]: () => new Response(JSON.stringify({ streams: [{ url: 'https://cdn.example/same.mp4' }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
      },
      [],
    ),
    dnsResolver: publicResolver,
  });
  ok(deduped.sources.length === 1, 'K: identical URLs across addons deduplicate (first wins)');

  // Series scoping: missing season/episode is a typed resolution error.
  await rejects(
    () => resolveStremioStreams({} as never, { mediaType: 'series' as const, identifiers: { imdbId: 'tt123', tmdbId: null } }, { loadAddons: async () => [first], fetcher: createFetcher({}, []), dnsResolver: publicResolver }),
    (error) => error instanceof StreamServiceError,
    'K: series request without season/episode is rejected (typed)',
  );

  ok(STREAM_RESOLUTION_CONCURRENCY === 4, 'K: concurrency constant stays at 4 (spec §7)');
}

// ===========================================================================
// L. Admin mutation authz re-pins
// ===========================================================================
{
  const routeSource = readRepoFile('src/routes/admin/addons/+page.server.ts');
  ok(routeSource.includes("import { requireAdmin } from '$lib/server/streaming/admin-auth'"), 'L: admin route imports the shared requireAdmin gate');
  ok(countOccurrences(routeSource, 'await requireAdmin(') === 7, 'L: requireAdmin runs on the load AND all six mutations (7 call sites)');
  for (const action of ['previewAddon', 'confirmAddon', 'setEnabled', 'refreshAddon', 'moveAddon', 'deleteAddon']) {
    ok(routeSource.includes(`${action}:`), `L: action ${action} exists and is gated`);
  }

  const abortResult = classifyAdminMutationError(Object.assign(new Error('aborted'), { name: 'AbortError' }), 'fallback');
  ok(abortResult.status === 'unknown' && abortResult.message.includes('Refresh'), 'L: abort errors classify as retryable-unknown with the fixed message');

  const timeoutResult = classifyAdminMutationError(new Error('network hiccup'), 'fallback');
  ok(timeoutResult.status === 'unknown' && !timeoutResult.message.includes('network hiccup'), 'L: network-ish errors classify as retryable-unknown (raw text never surfaces)');

  const nonError = classifyAdminMutationError('not an error', 'fallback');
  ok(nonError.status === 'unknown' && nonError.message.includes('could not be confirmed'), 'L: non-Error throwables classify to the fixed unknown message');
}

// ===========================================================================
// M. Admin ordering integrity (behavioral, minimal PostgREST-style fake)
// ===========================================================================
{
  type Row = { id: string; ordering: number; name: string; created_at: string };
  function fakeAdminDb(initial: Row[]) {
    const state = { rows: initial.map((row) => ({ ...row })), updates: [] as Array<{ id: string; patch: Record<string, unknown> }> };
    const sortRows = (orders: Array<{ column: string }>) => {
      const sorted = [...state.rows];
      for (const order of [...orders].reverse()) {
        sorted.sort((a, b) => String(a[order.column as keyof Row]).localeCompare(String(b[order.column as keyof Row])));
      }
      return sorted;
    };
    const client = {
      from(_table: string) {
        let op: 'select' | 'delete' | 'update' | null = null;
        let wantsReturn = false;
        let patch: Record<string, unknown> = {};
        const filters: Array<[string, unknown]> = [];
        const orders: Array<{ column: string }> = [];
        const matches = (row: Row) => filters.every(([col, val]) => row[col as keyof Row] === val);
        const builder = {
          select() {
            if (!op) op = 'select';
            wantsReturn = true;
            return this;
          },
          update(value: Record<string, unknown>) {
            if (!op) op = 'update';
            patch = value;
            return this;
          },
          delete() {
            if (!op) op = 'delete';
            return this;
          },
          eq(column: string, value: unknown) {
            filters.push([column, value]);
            return this;
          },
          order(column: string) {
            orders.push({ column });
            return this;
          },
          limit() {
            return this;
          },
          maybeSingle() {
            const result = this.execute();
            if (op === 'delete') {
              return Promise.resolve({ data: result.deleted && wantsReturn ? { id: result.deleted.id } : null, error: null });
            }
            return Promise.resolve({ data: result.single ?? null, error: null });
          },
          execute(): { rows: Row[]; single?: Row | null; deleted?: Row } {
            if (op === 'select') {
              const matching = sortRows(orders).filter(matches);
              return { rows: matching, single: matching[0] ?? null };
            }
            if (op === 'update') {
              for (const row of state.rows) {
                if (matches(row)) {
                  Object.assign(row, patch);
                  state.updates.push({ id: row.id, patch: { ...patch } });
                }
              }
              return { rows: [] };
            }
            // delete
            let deleted: Row | undefined;
            state.rows = state.rows.filter((row) => {
              const match = matches(row);
              if (match) deleted = row;
              return !match;
            });
            return { rows: [], deleted };
          },
          then(onFulfilled: (value: { data: unknown; error: null }) => unknown) {
            const result = this.execute();
            let data: unknown;
            if (op === 'select') data = result.rows;
            else if (op === 'delete') data = result.deleted && wantsReturn ? { id: result.deleted.id } : null;
            else data = null;
            return Promise.resolve({ data, error: null }).then(onFulfilled);
          },
        };
        return builder;
      },
    };
    return { client, state };
  }

  const baseRows = (): Row[] => [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ordering: 0, name: 'Alpha', created_at: '2026-09-01T00:00:00Z' },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ordering: 1, name: 'Beta', created_at: '2026-09-01T00:00:00Z' },
    { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', ordering: 2, name: 'Gamma', created_at: '2026-09-01T00:00:00Z' },
  ];
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  const swap = fakeAdminDb(baseRows());
  await moveAddon(swap.client as never, B, 'up');
  ok(
    swap.state.updates.length >= 2 && swap.state.rows.find((r) => r.id === A)?.ordering === 1 && swap.state.rows.find((r) => r.id === B)?.ordering === 0 && swap.state.rows.find((r) => r.id === C)?.ordering === 2,
    'M: adjacent swap persists a complete, consistent numbering',
  );

  const edge = fakeAdminDb(baseRows());
  await moveAddon(edge.client as never, A, 'up');
  ok(edge.state.updates.length === 0 && edge.state.rows.every((r, i) => r.ordering === i), 'M: move past the top edge is a no-op (no writes)');

  const tie = fakeAdminDb([
    { id: A, ordering: 0, name: 'Alpha', created_at: '2026-09-01T00:00:00Z' },
    { id: B, ordering: 0, name: 'Beta', created_at: '2026-09-01T00:00:00Z' },
    { id: C, ordering: 1, name: 'Gamma', created_at: '2026-09-01T00:00:00Z' },
  ]);
  await moveAddon(tie.client as never, B, 'up');
  const tieOrderings = tie.state.rows.map((r) => r.ordering).sort((x, y) => x - y);
  ok(JSON.stringify(tieOrderings) === '[0,1,2]', 'M: concurrent/tied orderings self-heal to absolute positions');

  const del = fakeAdminDb(baseRows());
  await deleteAddonById(del.client as never, B);
  ok(del.state.rows.length === 2 && !del.state.rows.some((r) => r.id === B), 'M: delete removes exactly the target row');

  await rejects(
    () => deleteAddonById(del.client as never, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
    (error) => error instanceof StreamingValidationError && error.message === 'Addon not found.',
    'M: deleting an unknown addon is a typed not-found error',
  );

  await rejects(
    () => moveAddon(del.client as never, B, 'sideways' as never),
    (error) => error instanceof StreamingValidationError && error.message === 'Move direction is invalid.',
    'M: invalid move direction is a typed validation error',
  );
}

// ===========================================================================
// N. Manifest cache bounds (poison-resistance)
// ===========================================================================
{
  const cache = createManifestCache({ ttlMs: 1000, maxEntries: 2 });
  const manifestA = validateStremioManifest(JSON.parse(manifestBody({ name: "A" })));
  const manifestB = validateStremioManifest(JSON.parse(manifestBody({ name: "B" })));
  const manifestC = validateStremioManifest(JSON.parse(manifestBody({ name: "C" })));

  cache.set('a', manifestA, 'https://a/final', 0);
  ok(cache.get('a', 500) !== undefined, 'N: entry alive within TTL');
  ok(cache.get('a', 1500) === undefined, 'N: entry expired after TTL (bounded lifetime)');

  cache.set('a', manifestA, '', 0);
  cache.set('b', manifestB, '', 0);
  cache.set('c', manifestC, '', 0);
  ok(cache.size() === 2 && cache.get('a', 0) === undefined && cache.get('c', 0) !== undefined, 'N: max-entries eviction drops the oldest entry');

  const retrieved = cache.get('c', 0);
  if (retrieved) (retrieved.manifest as { name: string }).name = 'POISONED';
  ok(cache.get('c', 0)?.manifest.name === 'C', 'N: cache returns copies — callers cannot poison stored manifests');

  cache.set('c', manifestB, '', 0);
  ok(cache.size() === 2 && cache.get('c', 0)?.manifest.name === 'B', 'N: set replaces the same key without growing');

  ok(cache.get('c', 0) !== undefined && 'finalUrl' in (cache.get('c', 0) as Record<string, unknown>) && !('body' in (cache.get('c', 0) as Record<string, unknown>)), 'N: cache entries hold the small normalized manifest only (never raw response bytes)');
  ok(defaultManifestCache.size() <= MANIFEST_CACHE_MAX_ENTRIES && defaultManifestCache.size() === 0, 'N: module default cache is bounded and starts empty');
}

// ===========================================================================
// O. XSS / rendering pins (Svelte escaping everywhere)
// ===========================================================================
{
  const srcFiles = walkSources('src').filter((file) => /\.(svelte|ts|js)$/.test(file));
  const htmlInjections = srcFiles.filter((file) => readRepoFile(file).includes('{@html'));
  ok(htmlInjections.length === 0, `O: zero {@html injections in the entire src tree (found ${htmlInjections.length})`);

  const adminPage = readRepoFile('src/routes/admin/addons/+page.svelte');
  ok(!adminPage.includes('<img') && !adminPage.includes('innerHTML'), 'O: admin addons page never renders remote images or raw HTML (logo fallback policy)');

  const playerShell = readRepoFile('src/lib/components/player/PlayerShell.svelte');
  ok(!playerShell.includes('innerHTML'), 'O: player shell never uses innerHTML');
  ok(playerShell.includes('engineQuality'), 'O: player shell stays engine-agnostic (Phase 5 contract intact)');
}

// ===========================================================================
// P. User/admin isolation & RLS re-pins
// ===========================================================================
{
  const migration = readRepoFile('supabase/migrations/20260918000000_phase1_stremio_addons.sql');
  ok(migration.includes('using ((select public.is_admin()))') && migration.includes('with check ((select public.is_admin()))'), 'P: streaming_addons RLS policies gate on public.is_admin()');
  ok(/enable row level security/i.test(migration), 'P: streaming_addons has RLS enabled');

  const playbackSource = readRepoFile('src/routes/api/playback/stremio/+server.ts');
  ok(!playbackSource.includes('manifest_url'), 'P: playback endpoint never exposes manifest URLs');
  ok(playbackSource.includes('export const POST') && !playbackSource.includes('export const GET'), 'P: playback endpoint is POST-only (identifiers via JSON body)');
  ok(playbackSource.includes('resolveStremioStreams') && playbackSource.includes('maveroPlayerSourceFromResolution'), 'P: playback endpoint delegates to the Phase 3 resolver + Phase 4 source composer');
  ok(!playbackSource.includes('requireAdmin'), 'P: playback stays user-facing (no admin requirement added)');
}

// ===========================================================================
// Q. HLS engine pins (hls.js 1.7.2 contract intact)
// ===========================================================================
{
  const lockfile = readRepoFile('pnpm-lock.yaml');
  ok(lockfile.includes('hls.js@1.7.2'), 'Q: lockfile resolves hls.js to exactly 1.7.2');
  ok(lockfile.includes('undici@8.10.2'), 'Q: lockfile resolves undici to exactly 8.10.2');

  const engine = readRepoFile('src/lib/client/player/hls-engine.ts');
  ok(engine.includes("import('hls.js')"), 'Q: hls.js is lazily imported by the engine only');
  ok(engine.includes('.destroy('), 'Q: engine tears down hls.js instances (lifecycle hygiene)');
  ok(engine.includes('setAutoQualityLevel') && engine.includes('nextLevel'), 'Q: Phase 6 seamless quality API intact');
  ok(engine.includes('vnd.apple.mpegurl'), 'Q: native HLS branch preserved (Safari path)');

  const shell = readRepoFile('src/lib/components/player/PlayerShell.svelte');
  ok(!shell.toLowerCase().includes('hls'), 'Q: player shell remains 100% engine-name-free (Phase 5 contract)');

  const clientPlayerFiles = ['src/lib/client/player/mavero-streams.ts', 'src/lib/components/player/PlayerControls.svelte', 'src/lib/components/player/PlayerViewport.svelte'];
  ok(clientPlayerFiles.every((file) => !/from 'hls\.js'|import\('hls\.js'\)/.test(readRepoFile(file))), 'Q: no other player module imports hls.js directly');
}

// ===========================================================================
// R. Error hygiene / no leakage
// ===========================================================================
{
  const ipPattern = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
  const errorsSource = readRepoFile('src/lib/server/streaming/stremio/errors.ts');
  ok(!ipPattern.test(errorsSource) && !errorsSource.includes('ECONNREFUSED') && !errorsSource.includes('ENOTFOUND'), 'R: manifest error messages carry no IPs or DNS internals');
  const streamErrorsSource = readRepoFile('src/lib/server/streaming/stremio/stream-errors.ts');
  ok(!ipPattern.test(streamErrorsSource) && !streamErrorsSource.includes('ECONNREFUSED'), 'R: stream error messages carry no internals');

  const oversized = new ManifestServiceError('NETWORK', { message: 'x'.repeat(1100) });
  const truncated = sanitizeLastError(oversized);
  ok(truncated.length <= 1000 && truncated.endsWith('...'), 'R: persisted error text is truncated to the DB limit');
  ok(sanitizeLastError(new TypeError('raw 10.0.0.1 leak')) === 'An unexpected error occurred while checking the addon manifest.', 'R: foreign errors never reach last_error raw');

  const wrapped = asManifestServiceError(new TypeError('connect EHOSTUNREACH 10.1.2.3:443'));
  ok(wrapped.code === 'UNEXPECTED' && wrapped.message === 'An unexpected error occurred while checking the addon manifest.', 'R: foreign errors collapse to the fixed UNEXPECTED message (raw cause never surfaces)');

  const manifestServiceSource = readRepoFile('src/lib/server/streaming/stremio/manifest-service.ts');
  ok(countOccurrences(manifestServiceSource, 'console.warn') === 2 && !manifestServiceSource.includes('console.log'), 'R: manifest service logs only the two sanctioned server-side warns');
  const resolverConsoleWarns = countOccurrences(readRepoFile('src/lib/server/streaming/stremio/stream-resolver.ts'), 'console.warn');
  ok(resolverConsoleWarns === 1, 'R: resolver logs only the sanctioned unexpected-failure warn');
}

// ===========================================================================
// S. URL/stream security invariants
// ===========================================================================
{
  ok(MAVERO_PLAYER_SOURCE_ID === 'mavero-player', 'S: MAVERO virtual source id unchanged');
  const maveroSource = readRepoFile('src/lib/server/streaming/stremio/mavero-player-source.ts');
  const streamPlayerSource = readRepoFile('src/lib/server/streaming/stremio/stream-player-source.ts');
  ok(!/\bfetch\(/.test(maveroSource) && !/\bfetch\(/.test(streamPlayerSource), 'S: media URLs are never fetched server-side (no proxy path)');

  const apiRoutes = readdirSync('src/routes/api');
  ok(!apiRoutes.some((entry) => entry.toLowerCase().includes('proxy')), 'S: no proxy route exists');

  const normalizeSource = readRepoFile('src/lib/server/streaming/stremio/stream-normalize.ts');
  ok(normalizeSource.includes('btih') && normalizeSource.includes('infoHash') && normalizeSource.includes('externalUrl'), 'S: torrent/debrid/externalUrl signals are explicitly handled in normalization');
  ok(normalizeSource.includes('magnet'), 'S: magnet URLs are explicitly rejected in normalization');
}

// ===========================================================================
// T. Logging & dependency hygiene
// ===========================================================================
{
  const stremioDir = 'src/lib/server/streaming/stremio';
  const moduleFiles = readdirSync(stremioDir).map((file) => `${stremioDir}/${file}`);
  let warnTotal = 0;
  let logTotal = 0;
  let serviceRoleRefs = 0;
  for (const file of moduleFiles) {
    const content = readRepoFile(file);
    warnTotal += countOccurrences(content, 'console.warn');
    logTotal += countOccurrences(content, 'console.log');
    serviceRoleRefs += countOccurrences(content.toLowerCase(), 'service_role');
  }
  ok(warnTotal === 3 && logTotal === 0, `T: stremio server modules log through exactly the 3 sanctioned warns (warn=${warnTotal}, log=${logTotal})`);
  ok(serviceRoleRefs === 0, 'T: no service-role key usage inside the stremio modules');

  const pkg = JSON.parse(readRepoFile('package.json'));
  ok('undici' in pkg.dependencies && !('undici' in (pkg.devDependencies ?? {})), 'T: undici is a runtime dependency (not dev-only)');

  const netlifyToml = readRepoFile('netlify.toml');
  ok(netlifyToml.includes('Permissions-Policy') && netlifyToml.includes('Referrer-Policy'), 'T: full security header set intact (Permissions-Policy, Referrer-Policy)');
}

// ===========================================================================
// U. Phase 8 scope & integrity
// ===========================================================================
{
  const stremioDir = 'src/lib/server/streaming/stremio';
  const inventory = readdirSync(stremioDir).sort();
  const expected = [
    'admin-addons.ts',
    'connect-guard.ts',
    'errors.ts',
    'manifest-cache.ts',
    'manifest-fetch.ts',
    'manifest-normalize.ts',
    'manifest-service.ts',
    'mavero-player-source.ts',
    'ssrf.ts',
    'stream-errors.ts',
    'stream-fetch.ts',
    'stream-ids.ts',
    'stream-normalize.ts',
    'stream-player-source.ts',
    'stream-resolver.ts',
  ].sort();
  ok(JSON.stringify(inventory) === JSON.stringify(expected), `U: stremio server dir inventory is exactly the Phase 1–8 module set (found ${inventory.join(', ')})`);

  ok(!readdirSync('scripts').some((file) => file.includes('phase8_undici_probe')), 'U: verification probes live outside the repo test chain');

  const connectGuardSource = readRepoFile(`${stremioDir}/connect-guard.ts`);
  const exportedNames = [...connectGuardSource.matchAll(/export (?:const|async function|function|type) (\w+)/g)].map((match) => match[1]);
  const allowedExports = new Set(['createConnectTimeLookup', 'ssrfSafeAgent', 'ssrfSafeFetch', 'ConnectLookupOptions', 'ConnectLookupCallback', 'ConnectLookupFunction', 'ConnectAddressValidator']);
  ok(exportedNames.length > 0 && exportedNames.every((name) => allowedExports.has(name)), `U: connect-guard exports ONLY guard primitives (${exportedNames.join(', ')})`);

  const ssrfSource = readRepoFile(`${stremioDir}/ssrf.ts`);
  for (const symbol of ['normalizeGuardedHostname', 'parseIpv4Literal', 'expandIpv6', 'isBlockedIpv4', 'isBlockedIpv6', 'isBlockedIpAddress', 'assertSafeManifestUrl', 'assertSafeManifestDestination', 'systemDnsResolver']) {
    ok(new RegExp(`export (?:async function|function|const|type) ${symbol}\\b`).test(ssrfSource), `U: Phase 2 ssrf surface intact (${symbol})`);
  }

  const worklog = readRepoFile('docs/addon-worklog.md');
  ok(worklog.includes('## Phase 8') && worklog.includes('DNS rebinding') && worklog.includes('undici'), 'U: addon worklog documents the Phase 8 hardening');

  const manifestCacheSource = readRepoFile(`${stremioDir}/manifest-cache.ts`);
  ok(manifestCacheSource.includes('createManifestCache()'), 'U: module default cache stays the bounded factory instance');
}

// ---------------------------------------------------------------------------
console.log(`stremio_player_phase8_test: ${passed} checks passed`);
if (passed < 150) {
  throw new Error(`Phase 8 suite unexpectedly small: ${passed} checks`);
}
