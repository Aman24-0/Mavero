import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { ManifestServiceError, type ManifestErrorCode } from '$lib/server/streaming/stremio/errors';
import { assertSafeManifestUrl, isBlockedIpAddress, type SafeDnsResolver } from '$lib/server/streaming/stremio/ssrf';
import { fetchStremioManifest } from '$lib/server/streaming/stremio/manifest-fetch';
import { getManifestCapabilities, persistableCapabilities, persistableResourceNames, supportsStreamResource, validateStremioManifest } from '$lib/server/streaming/stremio/manifest-normalize';
import { createManifestCache, manifestCacheKey } from '$lib/server/streaming/stremio/manifest-cache';
import { buildFailedManifestUpdate, buildSuccessfulManifestUpdate, fetchNormalizedManifest, refreshStaleAddonManifests, sanitizeLastError, syncAddonManifest, type AddonManifestTarget } from '$lib/server/streaming/stremio/manifest-service';
import type { StreamingAddonUpdate } from '$lib/server/streaming/addons';
import { mapAddonRow } from '$lib/server/streaming/addons';

// Phase 2: secure Stremio MANIFEST SERVICE contract tests.
//
// Scope: server-side manifest fetching (SSRF-safe), manifest validation and
// normalization, capability detection, and streaming_addons health/metadata
// persistence. NO /stream resolution, NO playback changes, NO torrent/P2P
// support, NO public endpoint. No test touches the real internet: fetch and
// DNS are always injected fakes.

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

async function rejectsCode(action: () => Promise<unknown>, code: ManifestErrorCode, label: string) {
  try {
    await action();
    assert.fail(`${label}: expected rejection with ${code}`);
  } catch (error) {
    assert.ok(error instanceof ManifestServiceError, `${label}: expected ManifestServiceError, got ${String(error)}`);
    assert.equal((error as ManifestServiceError).code, code, label);
  }
  passed += 1;
}

function throwsCode(action: () => unknown, code: ManifestErrorCode, label: string) {
  try {
    action();
    assert.fail(`${label}: expected throw with ${code}`);
  } catch (error) {
    assert.ok(error instanceof ManifestServiceError, `${label}: expected ManifestServiceError, got ${String(error)}`);
    assert.equal((error as ManifestServiceError).code, code, label);
  }
  passed += 1;
}

// ---------------------------------------------------------------------------
// Fakes — no test ever hits the real network
// ---------------------------------------------------------------------------

const PUBLIC_IP = { address: '93.184.216.34', family: 4 } as const;
const publicResolver: SafeDnsResolver = async () => [PUBLIC_IP];

type RouteHandler = (init?: RequestInit) => Response;

function jsonRoute(body: string, status = 200, headers: Record<string, string> = {}): RouteHandler {
  return () => new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
}

function redirectRoute(location: string, status = 302): RouteHandler {
  return () => new Response(null, { status, headers: { location } });
}

function createFetcher(routes: Record<string, RouteHandler>, calls: Array<{ url: string; signal: AbortSignal | null }>): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, signal: init?.signal ?? null });
    const handler = routes[url] ?? routes['*'];
    if (!handler) return new Response('not found', { status: 404 });
    return handler(init);
  }) as typeof fetch;
}

function manifestFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'community.example-addon',
    version: '1.2.3',
    name: 'Example Addon',
    description: 'An example HTTP addon',
    logo: 'https://cdn.example/logo.png',
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    idProperty: 'imdb_id',
    resources: [{ name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] }],
    ...overrides,
  };
}

const MANIFEST_BODY = JSON.stringify(manifestFixture());

function fakeClient(captured: StreamingAddonUpdate[]) {
  const builder = {
    update(payload: StreamingAddonUpdate) {
      return {
        eq(_column: string, _value: string) {
          captured.push(payload);
          return Promise.resolve({ error: null });
        },
      };
    },
    select() {
      return builder;
    },
    eq() {
      return builder;
    },
    or() {
      return builder;
    },
    order() {
      return builder;
    },
    limit(_count: number) {
      return Promise.resolve({ data: staleTargets, error: null });
    },
  };
  const client = { from(table: string) { assert.equal(table, 'streaming_addons'); return builder; } };
  return client as unknown as SupabaseClient<Database>;
}

const staleTargets: AddonManifestTarget[] = [];

// ---------------------------------------------------------------------------
// A. Valid HTTPS manifest
// ---------------------------------------------------------------------------
{
  const calls: Array<{ url: string; signal: AbortSignal | null }> = [];
  const fetcher = createFetcher({ 'https://addons.example/manifest.json': jsonRoute(MANIFEST_BODY) }, calls);
  const result = await fetchStremioManifest('https://addons.example/manifest.json', { fetcher, dnsResolver: publicResolver });
  ok(result.finalUrl === 'https://addons.example/manifest.json', 'A: finalUrl is the requested URL');
  const manifest = validateStremioManifest(result.body);
  ok(manifest.id === 'community.example-addon', 'A: id normalized');
  ok(manifest.version === '1.2.3', 'A: version normalized');
  ok(manifest.name === 'Example Addon', 'A: name normalized');
  ok(manifest.description === 'An example HTTP addon', 'A: description normalized');
  ok(manifest.logo === 'https://cdn.example/logo.png', 'A: logo normalized');
  ok(manifest.resources.includes('stream'), 'A: stream resource detected');
  ok(manifest.types.join(',') === 'movie,series', 'A: types normalized');
  ok(manifest.idPrefixes.join(',') === 'tt', 'A: idPrefixes normalized');
  ok(manifest.idProperty === 'imdb_id', 'A: idProperty normalized');
  ok(manifest.streamTypes.join(',') === 'movie,series', 'A: stream resource types captured');
  ok(calls.length === 1, 'A: exactly one network request');
  const normalized = await fetchNormalizedManifest('https://addons.example/manifest.json', { fetcher, dnsResolver: publicResolver });
  ok(normalized.manifest.name === 'Example Addon', 'A: fetchNormalizedManifest returns validated manifest');
}

// ---------------------------------------------------------------------------
// B. Valid HTTP manifest (http allowed for addon manifests)
// ---------------------------------------------------------------------------
{
  const fetcher = createFetcher({ 'http://addons.example/manifest.json': jsonRoute(MANIFEST_BODY) }, []);
  const result = await fetchStremioManifest('http://addons.example/manifest.json', { fetcher, dnsResolver: publicResolver });
  ok(result.finalUrl === 'http://addons.example/manifest.json', 'B: http manifest fetched');
  ok(validateStremioManifest(result.body).name === 'Example Addon', 'B: http manifest validates');
}

// ---------------------------------------------------------------------------
// C. Invalid protocol
// ---------------------------------------------------------------------------
{
  throwsCode(() => assertSafeManifestUrl('ftp://addons.example/manifest.json'), 'INVALID_URL', 'C: ftp rejected');
  throwsCode(() => assertSafeManifestUrl('file:///etc/passwd'), 'INVALID_URL', 'C: file rejected');
  throwsCode(() => assertSafeManifestUrl('javascript:alert(1)'), 'INVALID_URL', 'C: javascript rejected');
  await rejectsCode(() => fetchStremioManifest('ftp://addons.example/manifest.json', { fetcher: createFetcher({}, []), dnsResolver: publicResolver }), 'INVALID_URL', 'C: ftp fetch rejected');
  await rejectsCode(() => fetchStremioManifest('https://user:pass@addons.example/manifest.json', { fetcher: createFetcher({}, []), dnsResolver: publicResolver }), 'INVALID_URL', 'C: credentials rejected');
  await rejectsCode(() => fetchStremioManifest('   ', { fetcher: createFetcher({}, []), dnsResolver: publicResolver }), 'INVALID_URL', 'C: empty URL rejected');
}

// ---------------------------------------------------------------------------
// D. localhost blocked
// ---------------------------------------------------------------------------
{
  throwsCode(() => assertSafeManifestUrl('http://localhost/manifest.json'), 'BLOCKED_URL', 'D: localhost blocked');
  throwsCode(() => assertSafeManifestUrl('http://api.localhost/manifest.json'), 'BLOCKED_URL', 'D: subdomain-of-localhost blocked');
  throwsCode(() => assertSafeManifestUrl('http://LOCALHOST/manifest.json'), 'BLOCKED_URL', 'D: case-insensitive localhost blocked');
  throwsCode(() => assertSafeManifestUrl('http://localhost./manifest.json'), 'BLOCKED_URL', 'D: trailing-dot localhost blocked');
  throwsCode(() => assertSafeManifestUrl('http://metadata.google.internal/manifest.json'), 'BLOCKED_URL', 'D: cloud metadata hostname blocked');
  throwsCode(() => assertSafeManifestUrl('http://metadata.goog/manifest.json'), 'BLOCKED_URL', 'D: short cloud metadata hostname blocked');
}

// ---------------------------------------------------------------------------
// E. Loopback IP blocked
// ---------------------------------------------------------------------------
{
  throwsCode(() => assertSafeManifestUrl('http://127.0.0.1/manifest.json'), 'BLOCKED_URL', 'E: 127.0.0.1 blocked');
  throwsCode(() => assertSafeManifestUrl('http://127.255.255.254/manifest.json'), 'BLOCKED_URL', 'E: 127/8 blocked');
  throwsCode(() => assertSafeManifestUrl('http://[::1]/manifest.json'), 'BLOCKED_URL', 'E: [::1] blocked');
  ok(isBlockedIpAddress('127.0.0.1') && isBlockedIpAddress('::1'), 'E: loopback addresses blocked at IP layer');
}

// ---------------------------------------------------------------------------
// F. Private IPv4 + numeric IP representations blocked
// ---------------------------------------------------------------------------
{
  for (const host of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.50', '100.64.0.1', '198.18.0.9', '0.0.0.0', '224.0.0.5', '240.0.0.1', '255.255.255.255']) {
    throwsCode(() => assertSafeManifestUrl(`http://${host}/manifest.json`), 'BLOCKED_URL', `F: ${host} blocked`);
  }
  for (const host of ['2130706433', '0x7f000001', '0177.0.0.1', '127.1', '0x7f.0.0.1']) {
    throwsCode(() => assertSafeManifestUrl(`http://${host}/manifest.json`), 'BLOCKED_URL', `F: compact form ${host} blocked`);
  }
  throwsCode(() => assertSafeManifestUrl('http://[::ffff:10.0.0.5]/manifest.json'), 'BLOCKED_URL', 'F: IPv4-mapped private IPv6 blocked');
  throwsCode(() => assertSafeManifestUrl('http://[fd12::1]/manifest.json'), 'BLOCKED_URL', 'F: IPv6 ULA blocked');
  throwsCode(() => assertSafeManifestUrl('http://[ff02::2]/manifest.json'), 'BLOCKED_URL', 'F: IPv6 multicast blocked');
  throwsCode(() => assertSafeManifestUrl('http://[2001:db8::10]/manifest.json'), 'BLOCKED_URL', 'F: IPv6 documentation range blocked');
  ok(assertSafeManifestUrl('http://172.32.0.1/m.json') instanceof URL, 'F: public 172.32/12 allowed');
  ok(isBlockedIpAddress('::ffff:10.0.0.1'), 'F: mapped private address blocked at IP layer');
  ok(!isBlockedIpAddress('93.184.216.34'), 'F: public IPv4 allowed at IP layer');
  ok(!isBlockedIpAddress('2001:4860:4860::8888'), 'F: public IPv6 allowed at IP layer');
}

// ---------------------------------------------------------------------------
// G. Link-local blocked (incl. cloud metadata IP)
// ---------------------------------------------------------------------------
{
  throwsCode(() => assertSafeManifestUrl('http://169.254.169.254/latest/meta-data/'), 'BLOCKED_URL', 'G: AWS metadata IP blocked');
  throwsCode(() => assertSafeManifestUrl('http://[fe80::1]/manifest.json'), 'BLOCKED_URL', 'G: IPv6 link-local blocked');
  throwsCode(() => assertSafeManifestUrl('http://169.254.0.1/manifest.json'), 'BLOCKED_URL', 'G: whole 169.254/16 blocked');
}

// ---------------------------------------------------------------------------
// H. Unsafe redirect blocked (never fetched)
// ---------------------------------------------------------------------------
{
  const calls: Array<{ url: string; signal: AbortSignal | null }> = [];
  const fetcher = createFetcher({
    'https://addons.example/redirect': redirectRoute('http://127.0.0.1/private'),
  }, calls);
  await rejectsCode(
    () => fetchStremioManifest('https://addons.example/redirect', { fetcher, dnsResolver: publicResolver }),
    'BLOCKED_URL',
    'H: redirect to loopback blocked',
  );
  ok(calls.length === 1 && calls[0].url === 'https://addons.example/redirect', 'H: unsafe redirect destination never fetched');
}

// ---------------------------------------------------------------------------
// I. Safe redirect allowed
// ---------------------------------------------------------------------------
{
  const calls: Array<{ url: string; signal: AbortSignal | null }> = [];
  const fetcher = createFetcher({
    'https://a.example/old-manifest': redirectRoute('https://b.example/manifest.json'),
    'https://b.example/manifest.json': jsonRoute(MANIFEST_BODY),
  }, calls);
  const result = await fetchStremioManifest('https://a.example/old-manifest', { fetcher, dnsResolver: publicResolver });
  ok(result.finalUrl === 'https://b.example/manifest.json', 'I: finalUrl is redirect target');
  ok(validateStremioManifest(result.body).id === 'community.example-addon', 'I: manifest fetched after redirect');
  ok(calls.length === 2, 'I: initial request + validated redirect request');
}

// ---------------------------------------------------------------------------
// J. Redirect limit exceeded
// ---------------------------------------------------------------------------
{
  const calls: Array<{ url: string; signal: AbortSignal | null }> = [];
  const fetcher = createFetcher({
    'https://hop1.example/m': redirectRoute('https://hop2.example/m'),
    'https://hop2.example/m': redirectRoute('https://hop3.example/m'),
    'https://hop3.example/m': redirectRoute('https://hop4.example/m'),
    'https://hop4.example/m': redirectRoute('https://hop5.example/m'),
  }, calls);
  await rejectsCode(
    () => fetchStremioManifest('https://hop1.example/m', { fetcher, dnsResolver: publicResolver }),
    'NETWORK',
    'J: four redirects exceed the limit of three',
  );
  ok(calls.length === 4, 'J: stops after initial request + 3 redirects');
}

// ---------------------------------------------------------------------------
// K. Timeout
// ---------------------------------------------------------------------------
{
  const hangingFetcher = (async (_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
  })) as typeof fetch;
  await rejectsCode(
    () => fetchStremioManifest('https://slow.example/manifest.json', { fetcher: hangingFetcher, dnsResolver: publicResolver, timeoutMs: 25 }),
    'TIMEOUT',
    'K: slow request aborted by finite timeout',
  );
}

// ---------------------------------------------------------------------------
// L. Oversized response (Content-Length early reject + streaming cap)
// ---------------------------------------------------------------------------
{
  const earlyFetcher = createFetcher({
    '*': () => new Response(null, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(4 * 1048576) } }),
  }, []);
  await rejectsCode(
    () => fetchStremioManifest('https://addons.example/huge.json', { fetcher: earlyFetcher, dnsResolver: publicResolver }),
    'TOO_LARGE',
    'L: Content-Length above the cap rejected before reading',
  );

  const calls: Array<{ url: string; signal: AbortSignal | null }> = [];
  const chunk = new Uint8Array(64).fill(65);
  const streamingFetcher = createFetcher({
    '*': () => new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < 8; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  }, calls);
  await rejectsCode(
    () => fetchStremioManifest('https://addons.example/streamed.json', { fetcher: streamingFetcher, dnsResolver: publicResolver, maxBytes: 64 }),
    'TOO_LARGE',
    'L: streamed body above the cap rejected mid-read',
  );
  ok(calls.length === 1 && calls[0].signal?.aborted === true, 'L: in-flight request aborted on overflow');
}

// ---------------------------------------------------------------------------
// M. Invalid JSON body
// ---------------------------------------------------------------------------
{
  const fetcher = createFetcher({ '*': jsonRoute('not-json{') }, []);
  await rejectsCode(
    () => fetchStremioManifest('https://addons.example/broken.json', { fetcher, dnsResolver: publicResolver }),
    'INVALID_JSON',
    'M: unparseable body rejected',
  );
  const htmlFetcher = createFetcher({ '*': () => new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } }) }, []);
  await rejectsCode(
    () => fetchStremioManifest('https://addons.example/page', { fetcher: htmlFetcher, dnsResolver: publicResolver }),
    'INVALID_JSON',
    'M: obviously non-JSON content type rejected',
  );
}

// ---------------------------------------------------------------------------
// N. Non-object JSON rejected as invalid manifest
// ---------------------------------------------------------------------------
{
  for (const body of ['[1,2,3]', '"text"', '42', 'null', 'true']) {
    const fetcher = createFetcher({ '*': jsonRoute(body) }, []);
    await rejectsCode(
      () => fetchNormalizedManifest('https://addons.example/m.json', { fetcher, dnsResolver: publicResolver }),
      'INVALID_MANIFEST',
      `N: non-object JSON (${body}) rejected`,
    );
  }
}

// ---------------------------------------------------------------------------
// O. Malformed manifest structure
// ---------------------------------------------------------------------------
{
  throwsCode(() => validateStremioManifest({ ...manifestFixture(), id: '' }), 'INVALID_MANIFEST', 'O: empty id rejected');
  throwsCode(() => validateStremioManifest({ ...manifestFixture(), id: 'bad id with spaces' }), 'INVALID_MANIFEST', 'O: id with spaces rejected');
  throwsCode(() => validateStremioManifest({ id: 'x.y', name: 'n' }), 'INVALID_MANIFEST', 'O: missing version rejected');
  throwsCode(() => validateStremioManifest({ ...manifestFixture(), version: 'not-a-version' }), 'INVALID_MANIFEST', 'O: invalid version rejected');
  throwsCode(() => validateStremioManifest({ ...manifestFixture(), name: '' }), 'INVALID_MANIFEST', 'O: empty name rejected');
  throwsCode(() => validateStremioManifest({ ...manifestFixture(), name: 'x'.repeat(121) }), 'INVALID_MANIFEST', 'O: over-long name rejected');
  throwsCode(() => validateStremioManifest({ ...manifestFixture(), types: 'movie' }), 'INVALID_MANIFEST', 'O: non-array types rejected');
  throwsCode(() => validateStremioManifest({ ...manifestFixture(), idPrefixes: 'tt' }), 'INVALID_MANIFEST', 'O: non-array idPrefixes rejected');
  throwsCode(() => validateStremioManifest({ ...manifestFixture(), resources: 'stream' }), 'INVALID_MANIFEST', 'O: non-array resources rejected');
  throwsCode(() => validateStremioManifest({ ...manifestFixture(), resources: [] }), 'UNSUPPORTED_MANIFEST', 'O: empty resources unsupported');
  throwsCode(() => validateStremioManifest({ ...manifestFixture(), resources: [{ nope: true }] }), 'UNSUPPORTED_MANIFEST', 'O: fully-invalid resource entries unsupported');
  throwsCode(() => validateStremioManifest({ ...manifestFixture(), idProperty: 9 }), 'INVALID_MANIFEST', 'O: numeric idProperty rejected');
  throwsCode(() => validateStremioManifest({ ...manifestFixture(), idProperty: '9bad' }), 'INVALID_MANIFEST', 'O: idProperty with invalid shape rejected');
  throwsCode(() => validateStremioManifest({ ...manifestFixture(), idProperty: [] }), 'INVALID_MANIFEST', 'O: empty idProperty array rejected');
  throwsCode(() => validateStremioManifest('nope'), 'INVALID_MANIFEST', 'O: non-object manifest rejected');
}

// ---------------------------------------------------------------------------
// P. Valid manifest WITHOUT stream resource (stored, never treated as stream addon)
// ---------------------------------------------------------------------------
{
  const manifest = validateStremioManifest(manifestFixture({ resources: ['catalog', 'meta'] }));
  ok(supportsStreamResource(manifest) === false, 'P: catalog/meta addon does not support streams');
  const capabilities = getManifestCapabilities(manifest);
  ok(capabilities.supportsStream === false, 'P: capability view reports supportsStream=false');
  ok(capabilities.supportedTypes.join(',') === 'movie,series', 'P: non-stream addons keep declared types');
  const update = buildSuccessfulManifestUpdate(manifest, '2026-09-10T00:00:00.000Z');
  ok(update.resources?.join(',') === 'catalog,meta', 'P: resources persisted without stream');
  ok(update.status === 'active', 'P: successful check marks addon active (metadata still refreshed)');
}

// ---------------------------------------------------------------------------
// Q. Valid stream-capable manifest
// ---------------------------------------------------------------------------
{
  const manifest = validateStremioManifest(JSON.parse(MANIFEST_BODY));
  ok(supportsStreamResource(manifest) === true, 'Q: stream resource detected');
  const capabilities = getManifestCapabilities(manifest);
  ok(capabilities.supportsStream === true, 'Q: capability view reports supportsStream=true');
  ok(capabilities.supportedIdPrefixes.join(',') === 'tt', 'Q: idPrefixes surfaced for Phase 3');
  ok(capabilities.idProperty === 'imdb_id', 'Q: idProperty surfaced for Phase 3');
  const update = buildSuccessfulManifestUpdate(manifest, '2026-09-10T00:00:00.000Z');
  ok(update.resources?.includes('stream') === true, 'Q: stream capability persisted');
}

// ---------------------------------------------------------------------------
// R. Types normalization (strings, objects, dupes, casing)
// ---------------------------------------------------------------------------
{
  const manifest = validateStremioManifest(manifestFixture({
    types: ['Movie', { type_name: 'Series' }, 'movie', '  anime  ', 123, null, { noType: true }],
  }));
  ok(manifest.types.join(',') === 'movie,anime,series', 'R: mixed entries normalized, lowercased, deduplicated');
  ok(manifest.types.length === 3, 'R: invalid entries skipped');
  const empty = validateStremioManifest(manifestFixture({ types: undefined }));
  ok(Array.isArray(empty.types) && empty.types.length === 0, 'R: missing types default to empty array');
}

// ---------------------------------------------------------------------------
// S. idPrefixes normalization
// ---------------------------------------------------------------------------
{
  const manifest = validateStremioManifest(manifestFixture({ idPrefixes: ['tt', ' tt ', 'tt', 5, ''] }));
  ok(manifest.idPrefixes.join(',') === 'tt', 'S: idPrefixes trimmed and deduplicated');
  const absent = validateStremioManifest(manifestFixture({ idPrefixes: undefined }));
  ok(absent.idPrefixes.length === 0, 'S: missing idPrefixes default to empty array');
  // Stream-resource-level idPrefixes are captured too.
  const streamScoped = validateStremioManifest(manifestFixture({
    resources: [{ name: 'stream', idPrefixes: ['kai'] }],
  }));
  ok(streamScoped.streamIdPrefixes.join(',') === 'kai', 'S: stream-resource idPrefixes captured');
}

// ---------------------------------------------------------------------------
// T. idProperty handling (protocol semantics retained for Phase 3)
// ---------------------------------------------------------------------------
{
  ok(validateStremioManifest(manifestFixture({ idProperty: 'imdb_id' })).idProperty === 'imdb_id', 'T: string idProperty retained');
  ok(validateStremioManifest(manifestFixture({ idProperty: ['imdb_id', 'tt_id'] })).idProperty === 'imdb_id', 'T: array idProperty keeps first valid value');
  ok(validateStremioManifest(manifestFixture({ idProperty: undefined })).idProperty === undefined, 'T: absent idProperty stays undefined');
  ok(validateStremioManifest(manifestFixture()).idProperty === 'imdb_id', 'T: fixture idProperty retained');
  throwsCode(() => validateStremioManifest(manifestFixture({ idProperty: 'bad prop' })), 'INVALID_MANIFEST', 'T: idProperty with spaces rejected');
  throwsCode(() => validateStremioManifest(manifestFixture({ idProperty: {} })), 'INVALID_MANIFEST', 'T: object idProperty rejected');
}

// ---------------------------------------------------------------------------
// U. Successful DB metadata mapping
// ---------------------------------------------------------------------------
{
  const manifest = validateStremioManifest(JSON.parse(MANIFEST_BODY));
  const now = '2026-09-10T12:00:00.000Z';
  const update = buildSuccessfulManifestUpdate(manifest, now);
  ok(update.name === 'Example Addon', 'U: name refreshed from manifest');
  ok(update.description === 'An example HTTP addon', 'U: description refreshed');
  ok(update.logo === 'https://cdn.example/logo.png', 'U: logo refreshed');
  ok(update.version === '1.2.3', 'U: version refreshed');
  ok(update.id_property === 'imdb_id', 'U: id_property refreshed');
  ok(Array.isArray(update.supported_types) && update.supported_types?.join(',') === 'movie,series', 'U: supported_types refreshed');
  ok(Array.isArray(update.id_prefixes) && update.id_prefixes?.join(',') === 'tt', 'U: id_prefixes refreshed');
  ok(update.resources?.includes('stream'), 'U: resources refreshed');
  ok(update.status === 'active', 'U: status set to active');
  ok(update.last_checked_at === now && update.last_success_at === now, 'U: health timestamps set');
  ok(update.last_error === null, 'U: last_error cleared');
  ok(update.capabilities && typeof update.capabilities === 'object', 'U: capabilities is a JSON object');
  for (const adminOwned of ['id', 'slug', 'manifest_url', 'enabled', 'ordering', 'notes']) {
    ok(!(adminOwned in update), `U: admin-owned column "${adminOwned}" never written by the manifest service`);
  }
}

// ---------------------------------------------------------------------------
// V. Failed health-check metadata handling
// ---------------------------------------------------------------------------
{
  const now = '2026-09-10T13:00:00.000Z';
  const temporary = new ManifestServiceError('TIMEOUT');
  const temporaryUpdate = buildFailedManifestUpdate(temporary, now);
  ok(temporaryUpdate.last_checked_at === now, 'V: last_checked_at updated on temporary failure');
  ok(typeof temporaryUpdate.last_error === 'string' && temporaryUpdate.last_error.length > 0, 'V: sanitized error recorded');
  ok(temporaryUpdate.status === undefined, 'V: temporary failure keeps the administrator status');
  ok(!('name' in temporaryUpdate) && !('version' in temporaryUpdate), 'V: temporary failure preserves synced metadata');

  const permanent = new ManifestServiceError('INVALID_MANIFEST');
  const permanentUpdate = buildFailedManifestUpdate(permanent, now);
  ok(permanentUpdate.status === 'unavailable', 'V: permanent failure marks addon unavailable');
  ok(permanentUpdate.last_checked_at === now && typeof permanentUpdate.last_error === 'string', 'V: permanent failure health fields updated');
  ok(!('enabled' in permanentUpdate) && !('slug' in permanentUpdate), 'V: admin-owned columns untouched on failure');

  ok(buildFailedManifestUpdate(new ManifestServiceError('INVALID_URL'), now).status === 'unavailable', 'V: blocked/invalid URL is permanent');
  ok(buildFailedManifestUpdate(new ManifestServiceError('UNSUPPORTED_MANIFEST'), now).status === 'unavailable', 'V: unsupported manifest is permanent');
  ok(buildFailedManifestUpdate(new ManifestServiceError('HTTP_ERROR', { httpStatus: 503 }), now).status === undefined, 'V: HTTP 503 is temporary');
  ok(buildFailedManifestUpdate(new ManifestServiceError('TOO_LARGE'), now).status === undefined, 'V: oversized response is temporary');
  const longError = sanitizeLastError(new ManifestServiceError('INVALID_MANIFEST', { message: `x`.repeat(2000) }));
  ok(longError.length === 1000 && longError.endsWith('...'), 'V: over-long errors truncate to the DB limit');
}

// ---------------------------------------------------------------------------
// W. Sensitive data is never persisted
// ---------------------------------------------------------------------------
{
  const captured: StreamingAddonUpdate[] = [];
  const client = fakeClient(captured);
  const target: AddonManifestTarget = { id: '00000000-0000-4000-8000-00000000000a2', manifest_url: 'https://addons.example/manifest.json', status: 'experimental' };

  const success = await syncAddonManifest(client, target, { fetcher: createFetcher({ 'https://addons.example/manifest.json': jsonRoute(MANIFEST_BODY) }, []), dnsResolver: publicResolver, now: () => '2026-09-10T14:00:00.000Z' });
  ok(success.ok === true, 'W: successful sync outcome');
  const successUpdate = success.ok ? success.update : null;
  ok(successUpdate !== null && captured.length === 1, 'W: success update persisted once');
  const capabilityKeys = Object.keys((successUpdate?.capabilities ?? {}) as Record<string, unknown>);
  ok(capabilityKeys.every((key) => ['supportsStream', 'manifestId', 'manifestVersion', 'normalizedAt', 'streamTypes', 'streamIdPrefixes'].includes(key)), 'W: capabilities keys are whitelisted');
  const successBlob = JSON.stringify(successUpdate).toLowerCase();
  for (const secret of ['authorization', 'password', 'cookie', 'secret header']) {
    ok(!successBlob.includes(secret), `W: persisted update never contains "${secret}"`);
  }

  const failure = await syncAddonManifest(client, { ...target, manifest_url: 'https://addons.example/redirect' }, {
    fetcher: createFetcher({ 'https://addons.example/redirect': redirectRoute('http://127.0.0.1/private') }, []),
    dnsResolver: publicResolver,
    now: () => '2026-09-10T14:01:00.000Z',
  });
  ok(failure.ok === false && failure.errorCode === 'BLOCKED_URL', 'W: blocked redirect surfaces typed failure');
  const failureUpdate = failure.ok ? null : failure.update;
  ok(failureUpdate !== null && captured.length === 2, 'W: failure update persisted');
  const failureBlob = JSON.stringify(failureUpdate).toLowerCase();
  for (const leak of ['127.0.0.1', 'localhost', 'addons.example', 'stack', 'at object', 'private']) {
    ok(!failureBlob.includes(leak), `W: persisted error never leaks "${leak}"`);
  }

  // Malformed upstream manifest: response body text must never persist.
  const evilBody = JSON.stringify({ ...manifestFixture(), name: 'x' }) + ' "SECRET_RESPONSE_PAYLOAD_TOKEN"';
  const badJson = await syncAddonManifest(client, { ...target, manifest_url: 'https://addons.example/bad.json' }, {
    fetcher: createFetcher({ 'https://addons.example/bad.json': jsonRoute('{"broken": true, "password": "hunter2"') }, []), dnsResolver: publicResolver, now: () => '2026-09-10T14:02:00.000Z' });
  ok(badJson.ok === false && badJson.errorCode === 'INVALID_JSON', 'W: invalid JSON surfaces typed failure');
  ok(!JSON.stringify(badJson.update).includes('hunter2'), 'W: response body never persisted');

  const unexpected = await syncAddonManifest(client, { ...target, manifest_url: 'https://addons.example/boom.json' }, {
    fetcher: (async () => { throw new Error('internal stack trace detail'); }) as typeof fetch,
    dnsResolver: publicResolver,
    now: () => '2026-09-10T14:03:00.000Z',
  });
  ok(unexpected.ok === false && unexpected.errorCode === 'UNEXPECTED', 'W: unexpected errors collapse to safe UNEXPECTED');
  ok(!JSON.stringify(unexpected.update).includes('stack trace'), 'W: unexpected error details never persisted');
  ok(evilBody.includes('SECRET_RESPONSE_PAYLOAD_TOKEN') === true, 'W: fixture sanity');
}

// ---------------------------------------------------------------------------
// X. Torrent/P2P content is never accepted as a streaming capability
// ---------------------------------------------------------------------------
{
  const torrentish = validateStremioManifest(manifestFixture({
    types: ['movie', 'torrent'],
    resources: [{ name: 'stream', types: ['movie'] }, 'torrent'],
    description: 'Serves movie streams; also advertises torrents and magnet links.',
  }));
  ok(supportsStreamResource(torrentish) === true, 'X: stream capability comes only from the declared stream resource');
  const capabilities = getManifestCapabilities(torrentish);
  ok(!capabilities.supportedTypes.includes('torrent'), 'X: torrent type excluded from supportedTypes');
  ok(capabilities.supportedTypes.join(',') === 'movie', 'X: clean types survive filtering');
  ok(persistableResourceNames(torrentish).join(',') === 'stream', 'X: torrent resource name dropped from persisted resources');
  const persisted = persistableCapabilities(torrentish, '2026-09-10T15:00:00.000Z');
  ok(JSON.stringify(persisted).toLowerCase().includes('torrent') === false, 'X: persisted capabilities carry no torrent tokens');
  ok(torrentish.description?.includes('torrent') === true, 'X: descriptive text mentioning torrents does not invalidate the manifest');

  const torrentOnly = validateStremioManifest(manifestFixture({ resources: ['torrent'] }));
  ok(supportsStreamResource(torrentOnly) === false, 'X: torrent-only addon gains no stream capability');
  ok(persistableResourceNames(torrentOnly).length === 0, 'X: torrent-only addon persists no resources');

  const p2pType = validateStremioManifest(manifestFixture({ types: ['p2p-tv'], resources: ['stream'] }));
  ok(!getManifestCapabilities(p2pType).supportedTypes.includes('p2p-tv'), 'X: P2P-ish type token never becomes a streaming capability');
}

// ---------------------------------------------------------------------------
// Extra 1: DNS layer — private resolution blocked, public allowed, failure safe
// ---------------------------------------------------------------------------
{
  const privateResolver: SafeDnsResolver = async () => [{ address: '10.0.0.9', family: 4 }];
  await rejectsCode(
    () => fetchStremioManifest('https://addons.example/manifest.json', { fetcher: createFetcher({}, []), dnsResolver: privateResolver }),
    'BLOCKED_URL',
    'Extra1: DNS name resolving to private IP blocked',
  );
  const multiResolver: SafeDnsResolver = async () => [PUBLIC_IP, { address: '192.168.0.10', family: 4 }];
  await rejectsCode(
    () => fetchStremioManifest('https://addons.example/manifest.json', { fetcher: createFetcher({}, []), dnsResolver: multiResolver }),
    'BLOCKED_URL',
    'Extra1: EVERY resolved address is validated (mixed results blocked)',
  );
  const failingResolver: SafeDnsResolver = async () => { throw new Error('ENOTFOUND'); };
  await rejectsCode(
    () => fetchStremioManifest('https://addons.example/manifest.json', { fetcher: createFetcher({}, []), dnsResolver: failingResolver }),
    'NETWORK',
    'Extra1: DNS failure is a safe NETWORK error',
  );
  const networkFetcher = (async () => { throw new TypeError('fetch failed: ECONNREFUSED'); }) as typeof fetch;
  await rejectsCode(
    () => fetchStremioManifest('https://addons.example/manifest.json', { fetcher: networkFetcher, dnsResolver: publicResolver }),
    'NETWORK',
    'Extra1: fetch-layer TypeError maps to NETWORK',
  );
  const httpErrorFetcher = createFetcher({ '*': jsonRoute('{"unused": true}', 503) }, []);
  await rejectsCode(
    () => fetchStremioManifest('https://addons.example/manifest.json', { fetcher: httpErrorFetcher, dnsResolver: publicResolver }),
    'HTTP_ERROR',
    'Extra1: HTTP failure surfaces typed error',
  );
}

// ---------------------------------------------------------------------------
// Extra 2: TTL cache — bounded, hit avoids network, key normalization
// ---------------------------------------------------------------------------
{
  const cache = createManifestCache({ ttlMs: 60_000, maxEntries: 2 });
  let upstreamCalls = 0;
  const countingFetcher: typeof fetch = (async () => {
    upstreamCalls += 1;
    return new Response(MANIFEST_BODY, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const url = 'https://addons.example/manifest.json';
  await fetchNormalizedManifest(url, { fetcher: countingFetcher, dnsResolver: publicResolver, useCache: true, cache });
  const second = await fetchNormalizedManifest(url, { fetcher: countingFetcher, dnsResolver: publicResolver, useCache: true, cache });
  ok(second.manifest.id === 'community.example-addon', 'Extra2: cached manifest returned');
  ok(upstreamCalls === 1, 'Extra2: cache hit performs no network request');
  const manifestWithoutCache = await fetchNormalizedManifest(url, { fetcher: countingFetcher, dnsResolver: publicResolver, useCache: false, cache });
  ok(manifestWithoutCache.manifest.name === 'Example Addon' && upstreamCalls === 2, 'Extra2: health flows bypass cache by default');
  ok(manifestCacheKey('HTTPS://ADDONS.EXAMPLE/manifest.json') === 'https://addons.example/manifest.json', 'Extra2: cache key is a normalized URL');
  // Bounded memory: third distinct entry evicts the oldest.
  await fetchNormalizedManifest('https://other1.example/m.json', { fetcher: countingFetcher, dnsResolver: publicResolver, useCache: true, cache });
  await fetchNormalizedManifest('https://other2.example/m.json', { fetcher: countingFetcher, dnsResolver: publicResolver, useCache: true, cache });
  ok(cache.size() === 2, 'Extra2: cache never exceeds maxEntries');
  ok(cache.get(manifestCacheKey(url)) === undefined, 'Extra2: oldest entry evicted');
}

// ---------------------------------------------------------------------------
// Extra 3: DB sync integration + stale refresh (fake client, no Supabase)
// ---------------------------------------------------------------------------
{
  const captured: StreamingAddonUpdate[] = [];
  const targets: AddonManifestTarget[] = [
    { id: 'addon-a', manifest_url: 'https://addons.example/a.json', status: 'experimental' },
    { id: 'addon-b', manifest_url: 'http://unreachable.example/b.json', status: 'active' },
  ];
  staleTargets.length = 0;
  staleTargets.push(...targets);
  const client = fakeClient(captured);
  const report = await refreshStaleAddonManifests(client, {
    deps: {
      fetcher: createFetcher({
        'https://addons.example/a.json': jsonRoute(MANIFEST_BODY),
      }, []),
      dnsResolver: publicResolver,
      now: () => '2026-09-10T16:00:00.000Z',
    },
  });
  ok(report.checked === 2 && report.succeeded === 1 && report.failed === 1, 'Extra3: stale refresh reports per-addon outcomes');
  ok(captured.length === 2, 'Extra3: both health outcomes persisted');
  const successUpdate = captured[0];
  ok(successUpdate.status === 'active' && successUpdate.name === 'Example Addon', 'Extra3: success persisted with manifest metadata');
  const failureUpdate = captured[1];
  ok(failureUpdate.last_checked_at === '2026-09-10T16:00:00.000Z', 'Extra3: failure updates last_checked_at');
  ok(failureUpdate.status === undefined, 'Extra3: temporary failure preserves status');
  ok(typeof failureUpdate.last_error === 'string' && failureUpdate.last_error.length > 0, 'Extra3: sanitized failure message persisted');
  ok(!JSON.stringify(failureUpdate).includes('unreachable.example'), 'Extra3: persisted error never contains the manifest URL');
  staleTargets.length = 0;
}

// ---------------------------------------------------------------------------
// Extra 4: Phase 1 boundary intact — DB/domain mapping still round-trips
// ---------------------------------------------------------------------------
{
  const row = {
    id: '00000000-0000-4000-8000-000000000000',
    name: 'Example Addon',
    slug: 'example-addon',
    description: 'desc',
    manifest_url: 'https://addons.example/manifest.json',
    enabled: true,
    status: 'active',
    ordering: 1,
    logo: null,
    version: '1.2.3',
    id_property: 'imdb_id',
    supported_types: ['movie'],
    id_prefixes: ['tt'],
    resources: ['stream'],
    last_checked_at: '2026-09-10T16:00:00.000Z',
    last_success_at: '2026-09-10T16:00:00.000Z',
    last_error: null,
    capabilities: { supportsStream: true, manifestId: 'community.example-addon', manifestVersion: '1.2.3', normalizedAt: '2026-09-10T16:00:00.000Z' },
    notes: null,
    created_at: '2026-09-10T15:00:00.000Z',
    updated_at: '2026-09-10T16:00:00.000Z',
  } as Parameters<typeof mapAddonRow>[0];
  const mapped = mapAddonRow(row);
  ok(mapped.manifestUrl === row.manifest_url && mapped.idProperty === 'imdb_id', 'Extra4: Phase 1 DB→domain mapping unchanged');
  ok(mapped.capabilities.supportsStream === true, 'Extra4: manifest capabilities survive the DB round-trip');
}

// ---------------------------------------------------------------------------
// Phase 3 corrective fix — EXPLICIT stream capability regression:
// a manifest that omits `resources` must NEVER be treated as a streaming
// addon (the raw protocol default ['catalog','meta','stream'] must not leak
// into Mavero's capability view).
// ---------------------------------------------------------------------------
{
  const omitted = validateStremioManifest(manifestFixture({ resources: undefined }));
  ok(omitted.resources.join(',') === 'catalog,meta', 'Fix: omitted resources normalize to the Mavero default without stream');
  ok(supportsStreamResource(omitted) === false, 'Fix: omitted resources NEVER imply stream support');
  ok(getManifestCapabilities(omitted).supportsStream === false, 'Fix: capability view reports supportsStream=false for omitted resources');
  const omittedUpdate = buildSuccessfulManifestUpdate(omitted, '2026-09-10T00:00:00.000Z');
  ok((omittedUpdate.capabilities as Record<string, unknown>).supportsStream === false, 'Fix: persisted capability is explicit-only');
  ok((omittedUpdate.resources ?? []).includes('stream') === false, 'Fix: persisted resources never claim an undeclared stream resource');
  ok((omittedUpdate.capabilities as Record<string, unknown>).supportsStream !== true, 'Fix: the raw protocol default never reaches the persisted capability');
  // Explicit declarations keep working unchanged (control).
  const explicit = validateStremioManifest(manifestFixture({ resources: ['catalog', 'meta', 'stream'] }));
  ok(supportsStreamResource(explicit) === true, 'Fix: explicitly declared stream resource still detected');
  const explicitObject = validateStremioManifest(manifestFixture());
  ok(supportsStreamResource(explicitObject) === true, 'Fix: explicit stream resource object still detected');
  // Persisted stream-scoped capability keys (Phase 3 additive whitelist).
  const scopedUpdate = buildSuccessfulManifestUpdate(explicitObject, '2026-09-10T00:00:00.000Z');
  const scopedCapabilities = scopedUpdate.capabilities as Record<string, unknown>;
  ok(Array.isArray(scopedCapabilities.streamTypes) && Array.isArray(scopedCapabilities.streamIdPrefixes), 'Fix: stream-scoped capability arrays persisted for the resolver');
  ok((scopedCapabilities.streamTypes as string[]).join(',') === 'movie,series', 'Fix: stream resource types persisted');
  ok((scopedCapabilities.streamIdPrefixes as string[]).join(',') === 'tt', 'Fix: stream resource idPrefixes persisted');
}

console.log(`stremio_addons_phase2_test: ${passed} checks passed`);

