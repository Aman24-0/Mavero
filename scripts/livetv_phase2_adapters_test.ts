/**
 * UNIFIED LIVE TV — Phase 2 adapter contract + secure fetching verification.
 *
 * Covers the Phase 2 brief §3/§5/§6/§7 requirements:
 *   §1  adapter registry — identity, support resolution, typed
 *       adapter_unavailable for types without a Phase 2 adapter.
 *   §2  fetch-safe SSRF — stage-1 + stage-2 guards (private/loopback/
 *       metadata DNS answers rejected), https-only, per-hop redirect
 *       re-validation (redirect into a private net is blocked), bounded
 *       redirects.
 *   §3  fetch-safe bounds — byte cap (header + streamed overflow), timeout,
 *       cancellation, content-type sanity (HTML is never a source document;
 *       non-JSON rejected for the JSON gate), typed error mapping.
 *   §4  diagnostics safety — errors never carry URLs with query strings,
 *       credentials, or upstream bodies.
 *   §5  api catalogue — payload-shape validation, per-entry isolation,
 *       duplicate ids, entry cap, EXPLICIT endpoint field mappings with
 *       independent classification (direct vs embed), no assumed streams.
 *   §6  LiveGT adapter — config validation, embed endpoint synthesis via the
 *       client's documented builder, non-digit id degradation, wire
 *       embed/watch fields NEVER read, direct endpoints NEVER persisted
 *       (fresh-signed contract), capability honesty, fetch-error mapping.
 *   §7  isolation — one failing source never affects another (per-entry +
 *       per-source error separation at the contract level).
 *
 * NO real network (injected fetchers/resolvers only), NO database.
 */

import assert from 'node:assert/strict';

let passed = 0;
function ok(condition: unknown, label: string, hint?: string) {
  assert.ok(condition, hint ? `${label} (${hint})` : label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

import {
  fetchLivetvSourceText,
  fetchLivetvSourceJson,
  LivetvSourceFetchError
} from '../src/lib/server/livetv/fetch-safe';
import {
  LIVETV_ADAPTERS,
  resolveLivetvAdapter,
  requireLivetvAdapter,
  livetvAdapterIdFor
} from '../src/lib/server/livetv/adapters';
import {
  LivetvAdapterError,
  adapterErrorFromFetch,
  sanitizeAdapterMetadata,
  normalizeSourceChannelId,
  normalizeChannelName,
  normalizeLogoUrl
} from '../src/lib/server/livetv/adapters/types';
import {
  LIVETV_DOCUMENTED_CATALOGUE_PROFILE_V1,
  normalizeApiCataloguePayload,
  apiCatalogueAdapter,
  type LivetvApiCatalogueProfile
} from '../src/lib/server/livetv/adapters/api-catalogue';
import { livegtV1Adapter } from '../src/lib/server/livetv/adapters/livegt-v1';
import { m3uPlaylistAdapter } from '../src/lib/server/livetv/adapters/m3u';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

// ============================================================
console.log('§1 adapter registry');
// ============================================================
{
  ok(LIVETV_ADAPTERS.length === 3, '§1.1 three Phase 2 adapters registered');
  ok(resolveLivetvAdapter('m3u_playlist') === m3uPlaylistAdapter, '§1.2 m3u_playlist → m3u adapter');
  ok(resolveLivetvAdapter('api_provider') === apiCatalogueAdapter, '§1.3 api_provider → catalogue adapter');
  ok(resolveLivetvAdapter('builtin_livegt_v1') === livegtV1Adapter, '§1.4 builtin_livegt_v1 → LiveGT adapter');
  ok(resolveLivetvAdapter('embed_provider') === null && resolveLivetvAdapter('manual_stream') === null, '§1.5 embed_provider/manual_stream have NO Phase 2 ingestion adapter (typed gap, not a silent no-op)');
  let unavailable: unknown = null;
  try {
    requireLivetvAdapter('embed_provider');
  } catch (error) {
    unavailable = error;
  }
  ok(unavailable instanceof LivetvAdapterError && unavailable.kind === 'adapter_unavailable', '§1.6 requesting an unregistered adapter throws the typed adapter_unavailable error');
  ok(livetvAdapterIdFor('builtin_livegt_v1') === 'builtin_livegt_v1' && livetvAdapterIdFor('manual_stream') === null, '§1.7 adapter identity lookup');
  ok(m3uPlaylistAdapter.capabilities('m3u_playlist').playbackResolution === 'static_urls' && apiCatalogueAdapter.capabilities('api_provider').playbackResolution === 'none', '§1.8 capability honesty: m3u static URLs; the documented catalogue profile maps no endpoint fields');
}

// ============================================================
console.log('§2 fetch-safe SSRF guards');
// ============================================================
{
  // https-only re-assertion.
  let httpError: unknown = null;
  try {
    await fetchLivetvSourceText('http://cdn.example/playlist.m3u8', { fetcher: async () => new Response('x') });
  } catch (error) {
    httpError = error;
  }
  ok(httpError instanceof LivetvSourceFetchError && httpError.kind === 'invalid_url', '§2.1 http:// rejected (https-only policy, defense in depth)');

  // Stage-2: a DNS name resolving into a private range is blocked.
  let privateError: unknown = null;
  try {
    await fetchLivetvSourceText('https://rebind.example/playlist.m3u8', {
      fetcher: async () => new Response('x'),
      dnsResolver: async () => [{ address: '10.1.2.3', family: 4 }]
    });
  } catch (error) {
    privateError = error;
  }
  ok(privateError instanceof LivetvSourceFetchError && privateError.kind === 'blocked_url', '§2.2 DNS answer in a private range → blocked_url');

  // Cloud metadata.
  let metadataError: unknown = null;
  try {
    await fetchLivetvSourceText('https://169.254.169.254/latest/meta-data/', { fetcher: async () => new Response('x') });
  } catch (error) {
    metadataError = error;
  }
  ok(metadataError instanceof LivetvSourceFetchError && metadataError.kind === 'blocked_url', '§2.3 cloud-metadata IP literal blocked (stage 1)');

  // Loopback literal.
  let loopError: unknown = null;
  try {
    await fetchLivetvSourceText('https://127.0.0.1/playlist.m3u8', { fetcher: async () => new Response('x') });
  } catch (error) {
    loopError = error;
  }
  ok(loopError instanceof LivetvSourceFetchError && loopError.kind === 'blocked_url', '§2.4 loopback literal blocked');

  // Redirect into a private net is re-validated and blocked.
  let redirectError: unknown = null;
  try {
    await fetchLivetvSourceText('https://redirector.example/playlist.m3u8', {
      fetcher: (async () => new Response(null, { status: 302, headers: { location: 'https://internal.example/private.m3u8' } })) as typeof fetch,
      dnsResolver: async (hostname) => (hostname === 'redirector.example' ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '192.168.0.9', family: 4 }])
    });
  } catch (error) {
    redirectError = error;
  }
  ok(redirectError instanceof LivetvSourceFetchError && redirectError.kind === 'blocked_url', '§2.5 redirect destination re-validated (stage 1+2) — redirect into RFC1918 blocked');

  // Boundless redirect loop is bounded.
  let loopCount = 0;
  let redirectLoopError: unknown = null;
  try {
    await fetchLivetvSourceText('https://loop.example/a.m3u8', {
      fetcher: (async () => {
        loopCount += 1;
        return new Response(null, { status: 302, headers: { location: 'https://loop.example/b.m3u8' } });
      }) as typeof fetch,
      dnsResolver: async () => [{ address: '93.184.216.34', family: 4 }]
    });
  } catch (error) {
    redirectLoopError = error;
  }
  ok(redirectLoopError instanceof LivetvSourceFetchError && redirectLoopError.kind === 'network' && loopCount <= 5, '§2.6 redirect count bounded (≤3 hops + initial)');

  // A credentials-bearing source URL is rejected.
  let credError: unknown = null;
  try {
    await fetchLivetvSourceText('https://user:pass@cdn.example/playlist.m3u8', { fetcher: async () => new Response('x') });
  } catch (error) {
    credError = error;
  }
  ok(credError instanceof LivetvSourceFetchError && credError.kind === 'invalid_url', '§2.7 credentials in the source URL rejected by the stage-1 guard');
}

// ============================================================
console.log('§3 fetch-safe bounds + content-type sanity');
// ============================================================
{
  // Content-Length header cap.
  let tooLarge: unknown = null;
  try {
    await fetchLivetvSourceText('https://cdn.example/huge.m3u8', {
      fetcher: (async () => new Response('x', { headers: { 'content-length': String(100 * 1024 * 1024) } })) as typeof fetch,
      dnsResolver: async () => [{ address: '93.184.216.34', family: 4 }],
      maxBytes: 1024
    });
  } catch (error) {
    tooLarge = error;
  }
  ok(tooLarge instanceof LivetvSourceFetchError && tooLarge.kind === 'too_large', '§3.1 over-long Content-Length → too_large');

  // Streamed overflow (no trusted header).
  let streamed: unknown = null;
  const bigChunk = new Uint8Array(2048).fill(0x61);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 8; i += 1) controller.enqueue(bigChunk);
      controller.close();
    }
  });
  try {
    await fetchLivetvSourceText('https://cdn.example/stream.m3u8', {
      fetcher: (async () => new Response(stream, { headers: { 'content-type': 'audio/x-mpegurl' } })) as unknown as typeof fetch,
      dnsResolver: async () => [{ address: '93.184.216.34', family: 4 }],
      maxBytes: 4096
    });
  } catch (error) {
    streamed = error;
  }
  ok(streamed instanceof LivetvSourceFetchError && streamed.kind === 'too_large', '§3.2 streamed body overflow aborts the connection → too_large');

  // Timeout via a fetcher that honors the abort signal.
  let timeout: unknown = null;
  try {
    await fetchLivetvSourceText('https://slow.example/playlist.m3u8', {
      fetcher: ((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      })) as unknown as typeof fetch,
      dnsResolver: async () => [{ address: '93.184.216.34', family: 4 }],
      timeoutMs: 30
    });
  } catch (error) {
    timeout = error;
  }
  ok(timeout instanceof LivetvSourceFetchError && timeout.kind === 'timeout', '§3.3 deadline exceeded → timeout');

  // External cancellation.
  const controller = new AbortController();
  let cancelled: unknown = null;
  const pendingText = fetchLivetvSourceText('https://slow.example/playlist.m3u8', {
    fetcher: ((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    })) as unknown as typeof fetch,
    dnsResolver: async () => [{ address: '93.184.216.34', family: 4 }],
    timeoutMs: 2000,
    signal: controller.signal
  });
  controller.abort();
  try {
    await pendingText;
  } catch (error) {
    cancelled = error;
  }
  ok(cancelled instanceof LivetvSourceFetchError && cancelled.kind === 'cancelled', '§3.4 external cancellation → cancelled');

  // HTML is never a source document.
  let htmlError: unknown = null;
  try {
    await fetchLivetvSourceText('https://cdn.example/player', {
      fetcher: (async () => new Response('<html><body>player</body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })) as typeof fetch,
      dnsResolver: async () => [{ address: '93.184.216.34', family: 4 }]
    });
  } catch (error) {
    htmlError = error;
  }
  ok(htmlError instanceof LivetvSourceFetchError && htmlError.kind === 'unsupported_media_type', '§3.5 an HTML page is rejected before parsing (never a playlist/manifest)');

  // JSON gate: non-JSON payload rejected at the typed boundary.
  let badJson: unknown = null;
  try {
    await fetchLivetvSourceJson('https://cdn.example/catalogue', {
      fetcher: (async () => new Response('not json at all', { headers: { 'content-type': 'application/json' } })) as typeof fetch,
      dnsResolver: async () => [{ address: '93.184.216.34', family: 4 }]
    });
  } catch (error) {
    badJson = error;
  }
  ok(badJson instanceof LivetvSourceFetchError && badJson.kind === 'invalid_payload', '§3.6 broken JSON → invalid_payload');

  // JSON gate: XML content type rejected.
  let xmlType: unknown = null;
  try {
    await fetchLivetvSourceJson('https://cdn.example/catalogue', {
      fetcher: (async () => new Response('<?xml version="1.0"?><a/>', { headers: { 'content-type': 'text/xml' } })) as typeof fetch,
      dnsResolver: async () => [{ address: '93.184.216.34', family: 4 }]
    });
  } catch (error) {
    xmlType = error;
  }
  ok(xmlType instanceof LivetvSourceFetchError && xmlType.kind === 'unsupported_media_type', '§3.7 XML content type rejected by the JSON gate');

  // HTTP error status.
  let httpStatus: unknown = null;
  try {
    await fetchLivetvSourceJson('https://cdn.example/missing', {
      fetcher: (async () => new Response('nope', { status: 404 })) as typeof fetch,
      dnsResolver: async () => [{ address: '93.184.216.34', family: 4 }]
    });
  } catch (error) {
    httpStatus = error;
  }
  ok(httpStatus instanceof LivetvSourceFetchError && httpStatus.kind === 'http_error' && httpStatus.httpStatus === 404, '§3.8 HTTP error status → http_error with the status carried');
}

// ============================================================
console.log('§4 diagnostics safety');
// ============================================================
{
  const secretUrl = 'https://user:supersecret@cdn.example/playlist.m3u8?api_key=ABC123';
  let captured: unknown = null;
  try {
    await fetchLivetvSourceText(secretUrl, { fetcher: async () => new Response('x') });
  } catch (error) {
    captured = error;
  }
  const text = JSON.stringify(captured, Object.getOwnPropertyNames(captured as object));
  ok(captured instanceof LivetvSourceFetchError, '§4.1 the failing fetch produces a typed error');
  ok(!text.includes('supersecret') && !text.includes('ABC123'), '§4.2 the error never carries credentials or secret-bearing query params');
  let mapped: unknown = null;
  try {
    await fetchLivetvSourceText('https://rebind.example/x.m3u8?token=t', { fetcher: async () => new Response('x'), dnsResolver: async () => [{ address: '10.0.0.1', family: 4 }] });
  } catch (error) {
    mapped = error;
  }
  const mappedText = JSON.stringify(mapped, Object.getOwnPropertyNames(mapped as object));
  ok(!mappedText.includes('token=t'), '§4.3 even the requested URL query never reaches a diagnostic');
  const fetchMapped = adapterErrorFromFetch(new LivetvSourceFetchError('blocked_url', 'The source URL points at a network location that is not allowed.'));
  ok(fetchMapped instanceof LivetvAdapterError && fetchMapped.kind === 'blocked_url', '§4.4 fetch errors map 1:1 onto adapter error kinds');
}

// ============================================================
console.log('§5 api catalogue engine');
// ============================================================
{
  // Shape validation.
  let notObject: unknown = null;
  try {
    normalizeApiCataloguePayload([1, 2, 3], LIVETV_DOCUMENTED_CATALOGUE_PROFILE_V1);
  } catch (error) {
    notObject = error;
  }
  ok(notObject instanceof LivetvAdapterError && notObject.kind === 'invalid_payload', '§5.1 a non-object payload is a SOURCE-level invalid_payload');

  let noArray: unknown = null;
  try {
    normalizeApiCataloguePayload({ channels: 'nope' }, LIVETV_DOCUMENTED_CATALOGUE_PROFILE_V1);
  } catch (error) {
    noArray = error;
  }
  ok(noArray instanceof LivetvAdapterError && noArray.kind === 'invalid_payload', '§5.2 a missing/malformed channels array is a SOURCE-level invalid_payload');

  let cap: unknown = null;
  try {
    normalizeApiCataloguePayload(
      { channels: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }] },
      { ...LIVETV_DOCUMENTED_CATALOGUE_PROFILE_V1, maxEntries: 2 }
    );
  } catch (error) {
    cap = error;
  }
  ok(cap instanceof LivetvAdapterError && cap.kind === 'entry_cap_exceeded', '§5.3 the entry budget is enforced with a typed source-level error');

  // Per-entry isolation.
  const payload = {
    channels: [
      { id: 'a1', name: 'Alpha', category: 'News', logo: 'https://cdn.example/a.png' },
      { id: 'bad space', name: 'Bad Id' },
      { id: 'a2' },
      { id: 'a3', name: 'Gamma', logo: 'http://insecure.example/x.png' },
      { id: 'a1', name: 'Duplicate' },
      'not-an-object',
      { id: 'a4', name: 'Delta', category: 'Sports' },
      { id: 'a5', name: 'Echo', category: 'x'.repeat(500) }
    ]
  };
  const result = normalizeApiCataloguePayload(payload, LIVETV_DOCUMENTED_CATALOGUE_PROFILE_V1);
  ok(result.channels.length === 2, '§5.4 valid entries survive malformed neighbors (per-entry isolation)');
  ok(result.channels[0]!.sourceChannelId === 'a1' && result.channels[0]!.name === 'Alpha' && result.channels[0]!.category === 'News', '§5.5 documented profile fields mapped explicitly');
  ok(result.diagnostics.skippedCount === 6, '§5.6 each malformed entry skipped once');
  ok(result.diagnostics.skippedReasons['invalid_channel_id'] === 1 && result.diagnostics.skippedReasons['missing_name'] === 1 && result.diagnostics.skippedReasons['invalid_logo_url'] === 1 && result.diagnostics.skippedReasons['duplicate_channel_id'] === 1 && result.diagnostics.skippedReasons['invalid_entry_shape'] === 1 && result.diagnostics.skippedReasons['invalid_category'] === 1, '§5.7 typed per-entry reasons');
  ok(result.channels.every((c) => c.endpoints.length === 0), '§5.8 the documented profile maps NO playback endpoint fields — no assumed streams, source type never implies an engine');
  ok(result.channels[0]!.metadata['profile'] === 'documented-catalogue-json-v1', '§5.9 provenance carries the profile id');
}

// ============================================================
console.log('§6 explicit endpoint field mappings (generic contract)');
// ============================================================
{
  // A HYPOTHETICAL documented profile exercising the generic mapping engine
  // (synthetic fixture — no real provider is claimed or invented).
  const profile: LivetvApiCatalogueProfile = {
    profileId: 'test-documented-hypothetical',
    cataloguePath: '/catalogue.json',
    channelsKey: 'channels',
    fields: { id: 'id', name: 'name', category: null, logo: null },
    endpoints: [
      { field: 'streamUrl', kind: 'direct_stream', streamFormat: 'hls', label: 'HLS' },
      { field: 'playerPage', kind: 'embed_page', label: 'Embed' }
    ],
    maxEntries: 100
  };
  const result = normalizeApiCataloguePayload(
    {
      channels: [
        { id: 'e1', name: 'Both', streamUrl: 'https://cdn.example/e1.m3u8', playerPage: 'https://cdn.example/e1/embed' },
        { id: 'e2', name: 'Embed only', playerPage: 'https://cdn.example/e2/embed' },
        { id: 'e3', name: 'Bad stream', streamUrl: 'http://insecure.example/e3.m3u8' }
      ]
    },
    profile
  );
  ok(result.channels.length === 2, '§6.1 entries whose mapped endpoint fails validation are isolated (e3 skipped, e1/e2 kept)');
  const both = result.channels[0]!;
  ok(both.endpoints.length === 2, '§6.2 multiple endpoint mappings per entry supported');
  ok(both.endpoints[0]!.endpointKind === 'direct_stream' && both.endpoints[0]!.streamFormat === 'hls', '§6.3 the mapped direct endpoint keeps its EXPLICIT declared format');
  ok(both.endpoints[1]!.endpointKind === 'embed_page' && both.endpoints[1]!.streamFormat === null, '§6.4 the embed endpoint is classified INDEPENDENTLY (embed_page, no format)');
  const embedOnly = result.channels[1]!;
  ok(embedOnly.endpoints.length === 1 && embedOnly.endpoints[0]!.endpointKind === 'embed_page', '§6.5 an entry may carry only an embed endpoint');
  const reasons = result.diagnostics.entryErrors.map((e) => e.reason);
  ok(reasons.includes('endpoint_validation_failed'), '§6.6 a mapped endpoint failing the typed URL/kind contract (non-https) is a per-entry failure');
  ok(reasons.includes('endpoint_validation_failed') && result.diagnostics.skippedCount === 1, '§6.7 the declared kind decides the endpoint — a URL that cannot satisfy it never silently downgrades');
}

// ============================================================
console.log('§7 LiveGT V1 adapter');
// ============================================================
{
  ok(livegtV1Adapter.capabilities('builtin_livegt_v1').guide === true, '§7.1 capability honesty: the built-in source has a NATIVE guide (untouched)');
  ok(livegtV1Adapter.capabilities('builtin_livegt_v1').playbackResolution === 'fresh_signed', '§7.2 capability honesty: playback URLs are fresh-signed, NEVER persisted');
  ok(JSON.stringify(livegtV1Adapter.capabilities('builtin_livegt_v1').endpointKinds) === JSON.stringify(['embed_page']), '§7.3 only the embed page is materializable from the catalogue');

  // Config validation.
  let badConfig: unknown = null;
  try {
    await livegtV1Adapter.run({ id: 'x', slug: 'x', sourceType: 'builtin_livegt_v1', config: { rogue: 1 } }, { fetcher: async () => new Response('{}') });
  } catch (error) {
    badConfig = error;
  }
  ok(badConfig instanceof LivetvAdapterError && badConfig.kind === 'invalid_source_config', '§7.4 unknown config keys rejected (Phase 1 validator reuse)');

  // Successful catalogue run with embed synthesis.
  let capturedUrl = '';
  const cataloguePayload = {
    count: 3,
    channels: [
      { id: '143', name: 'Channel 143', category: 'News', logo: 'https://cdn.example/143.png', embed: 'https://evil.example/steal', watch: 'https://evil.example/watch' },
      { id: '9', name: 'Channel 9' },
      { id: 'not-digits', name: 'Weird Id' }
    ]
  };
  const run = await livegtV1Adapter.run(
    { id: 'src-1', slug: 'builtin-livegt-v1', sourceType: 'builtin_livegt_v1', config: {} },
    {
      fetcher: (async (url: RequestInfo | URL) => {
        capturedUrl = String(url);
        return jsonResponse(cataloguePayload);
      }) as unknown as typeof fetch,
      dnsResolver: async () => [{ address: '93.184.216.34', family: 4 }]
    }
  );
  ok(run.adapterId === 'builtin_livegt_v1', '§7.5 adapter identity on the run result');
  ok(capturedUrl.endsWith('/api/public/channels') && capturedUrl.startsWith('https://'), '§7.6 the fixed documented V1 catalogue endpoint is used (base from the existing client)');
  ok(run.channels.length === 3, '§7.7 all valid catalogue entries normalized');
  const ch143 = run.channels.find((c) => c.sourceChannelId === '143')!;
  ok(ch143.endpoints.length === 1 && ch143.endpoints[0]!.endpointKind === 'embed_page' && ch143.endpoints[0]!.url.includes('/embed/143'), '§7.8 the documented embed page is materialized as a typed embed_page endpoint (2026-10: URL now includes ?colour= param)');
  const serialized143 = JSON.stringify(ch143);
  ok(!serialized143.includes('evil.example'), '§7.9 the wire embed/watch fields are NEVER read or persisted (client parity)');
  ok(ch143.endpoints.every((e) => e.endpointKind !== 'direct_stream'), '§7.10 NO direct endpoint is persisted (fresh-signed contract — resolution stays with the existing client)');
  const weird = run.channels.find((c) => c.sourceChannelId === 'not-digits')!;
  ok(weird !== undefined, '§7.11 a non-digit id still normalizes as a channel');
  ok(run.diagnostics.skippedReasons['embed_url_unavailable'] === 1, '§7.12 a non-embeddable id degrades to a typed diagnostic (entry survives)');
  ok(ch143.name === 'Channel 143' && ch143.category === 'News' && ch143.logoUrl === 'https://cdn.example/143.png', '§7.13 provenance preserved verbatim');

  // Fetch failure mapping.
  let http: unknown = null;
  try {
    await livegtV1Adapter.run(
      { id: 'x', slug: 'x', sourceType: 'builtin_livegt_v1', config: {} },
      { fetcher: (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch, dnsResolver: async () => [{ address: '93.184.216.34', family: 4 }] }
    );
  } catch (error) {
    http = error;
  }
  ok(http instanceof LivetvAdapterError && http.kind === 'http_error', '§7.14 upstream HTTP failure → typed http_error (source-level)');
}

// ============================================================
console.log('§8 shared normalization + metadata bounds');
// ============================================================
{
  ok(normalizeSourceChannelId('143') === '143' && normalizeSourceChannelId('a b') === null && normalizeSourceChannelId('') === null, '§8.1 source-channel id validation (no whitespace/control)');
  ok(normalizeChannelName('  News One ') === 'News One' && normalizeChannelName('bad\x01') === null && normalizeChannelName('') === null, '§8.2 name validation (trims, rejects control chars)');
  ok(normalizeLogoUrl('https://cdn.example/x.png') === 'https://cdn.example/x.png' && normalizeLogoUrl('http://cdn.example/x.png') === null && normalizeLogoUrl('javascript:alert(1)') === null, '§8.3 logo validation (https-only)');
  const sanitized = sanitizeAdapterMetadata({ ok: 'fine', n: 5, b: true, nil: null, nested: { deep: true }, arr: [1], huge: 'x'.repeat(500), finite: Number.NaN });
  ok(Object.keys(sanitized).length === 5 && sanitized['ok'] === 'fine' && sanitized['n'] === 5 && sanitized['b'] === true && sanitized['nil'] === null && sanitized['finite'] === null, '§8.4 metadata sanitizer keeps bounded scalars (NaN → null), drops nested/arrays/huge');
  ok(Object.keys(sanitizeAdapterMetadata(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i])))).length === 24, '§8.5 metadata key count bounded (24)');
}

console.log(`\n=== livetv Phase 2 adapter verification: ${passed} checks PASSED ===`);
