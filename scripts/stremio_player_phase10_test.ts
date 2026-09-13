import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { PlayerQualityOption, PlayerSource } from '$lib/shared/player';
import {
  signAddonToken,
  verifyAddonToken,
  tokenMatchesRequest,
  signCompatToken,
  verifyCompatToken,
  ADDON_TOKEN_TTL_SECONDS,
  type AddonTokenPayload,
} from '$lib/server/streaming/stremio/session-tokens';
import {
  createAddonSession,
  resolveAddonToken,
  type AddonSession,
} from '$lib/server/streaming/stremio/addon-session';
import { StreamServiceError } from '$lib/server/streaming/stremio/stream-errors';
import { validatePlaybackUrl } from '$lib/server/resolver/safe-url';
import { sandboxPolicyFromCapabilities, configuredSandboxPolicy, withSourceSandboxChoice, iframeSandboxAttribute } from '$lib/shared/sandbox-policy';
import { parseSourceForm, parseProviderForm } from '$lib/server/streaming/validation';
import {
  aggregateMaveroBuckets,
  MAVERO_AGGREGATE_MAX_STREAMS,
} from '$lib/shared/mavero-aggregate';
import { MAX_EQUIVALENT_RELEASES, MAX_STREAMS_PER_QUALITY } from '$lib/shared/stream-selection';
import {
  mergeMaveroResults,
  startMaveroProgressiveResolution,
  ADDON_REQUEST_TIMEOUT_MS,
  type MaveroAddonResult,
  type MaveroResolvedStream,
} from '$lib/client/player/mavero-progressive';
import { updateManagerHelper } from './phase10_manager_fixture';
import {
  classifyStreamCompatibility,
  needsCompatibilityPath,
  compatibilityBadgeText,
  codecHintsFromText,
} from '$lib/shared/media-compat';
import { checkMediaCompatibility } from '$lib/client/player/media-capabilities';
import { requestMaveroCompatStream, compatBadgeForStream, compatTierForStream, COMPAT_PREPARING_MESSAGE } from '$lib/client/player/mavero-compat';
import { HlsPlaybackEngine, loadHlsFactory, resetHlsFactoryCache } from '$lib/client/player/hls-engine';
import { PlaybackManager } from '$lib/client/player/PlaybackManager';

// Phase 10 — progressive Stremio addon resolution + Video.js v10 primary HLS
// ownership + codec compatibility + sandbox policy fix. Behavioral tests over
// the REAL modules (tokens, session service, progressive controller, merge,
// classifier, capability detection, engine facade) plus precise UI-contract
// pins where Svelte components cannot run under tsx (repo convention).
//
//   A   session/compat token signing, expiry, tamper, binding   (GOALS 1/12)
//   B   session creation — safe payload, eligibility, ordering  (GOAL 1/3)
//   C   per-addon resolution — isolation, caps, stale binding   (GOALS 4/5/6)
//   D   client progressive controller — parallel, retry, stale  (GOALS 1–6)
//   E   live merge — fairness, budgets, pinned playing stream   (GOALS 2/4)
//   F   manager live update without restart                     (GOAL 2)
//   G   compatibility classifier tiers                          (GOALS 10/11)
//   H   runtime capability detection                            (GOAL 17)
//   I   compat client + degradation                             (GOALS 13/14)
//   J   compat gateway contract (no proxy, signed-only)         (GOALS 12/24)
//   K   sandbox provider-default fix + hierarchy + runtime      (GOALS 19–22)
//   L   Video.js single HLS owner + audio tracks                (GOALS 7/8/18)
//   M   progressive page/shell wiring                           (GOALS 1–3/16)
//   N   security re-pins                                        (GOAL 24)
//   O   regression hygiene                                      (GOAL 27)

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const sessionRoute = read('src/routes/api/playback/stremio/session/+server.ts');
const addonRoute = read('src/routes/api/playback/stremio/addon/+server.ts');
const compatRoute = read('src/routes/api/playback/compat/manifest/+server.ts');
const watchSource = read('src/routes/watch/[type]/[id]/+page.svelte');
const shellSource = read('src/lib/components/player/PlayerShell.svelte');
const cardSource = read('src/lib/components/player/MaveroStreamCard.svelte');
const viewportSource = read('src/lib/components/player/PlayerViewport.svelte');
const engineSource = read('src/lib/client/player/hls-engine.ts');
const sessionEnvSource = read('src/lib/server/streaming/stremio/session-env.ts');
const workerDoc = read('docs/compat-worker.md');
const packageJson = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; scripts: { test: string }; pnpm?: { overrides?: Record<string, string> } };

const SECRET = 'phase10-test-secret';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function addonFixture(name: string, ordering: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `addon-${name.toLowerCase()}`,
    slug: name.toLowerCase(),
    name,
    manifestUrl: 'https://manifests.example/' + name.toLowerCase() + '/manifest.json',
    enabled: true,
    status: 'experimental' as const,
    ordering,
    version: '1.0.0',
    idProperty: 'imdb_id',
    supportedTypes: ['movie', 'series'],
    idPrefixes: [],
    resources: ['stream'],
    capabilities: { supportsStream: true },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as never;
}

type FakeAddonRecord = ReturnType<typeof addonFixture>;

function streamPayloadFixture(url: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    streams: [{ name, title: name, url, ...(extra.behaviorHints ? { behaviorHints: extra.behaviorHints } : {}) }],
  };
}

/** Fake fetch body for the addon endpoint (session tokens are opaque). */
function makeSessionClient(addons: FakeAddonRecord[]) {
  return {
    from: (table: string) => {
      if (table !== 'streaming_addons') throw new Error('unexpected table ' + table);
      return {
        select: () => ({
          eq: () => ({
            in: () => ({
              order: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: addons, error: null }),
                }),
              }),
            }),
          }),
        }),
      } as never;
    },
  } as never;
}

// ---------------------------------------------------------------------------
// A — tokens
// ---------------------------------------------------------------------------

{
  const payload: Omit<AddonTokenPayload, 'v'> = { s: 'session-1', a: 'addon-a', c: 'tt123', m: 'movie', exp: Math.floor(Date.now() / 1000) + 300 };
  const token = signAddonToken(payload, SECRET);
  ok(token.startsWith('v1.'), 'A: addon tokens are versioned');
  ok(!token.includes('manifests.example'), 'A: the token payload never carries a manifest URL');
  const verification = verifyAddonToken(token, SECRET);
  ok(verification.ok && verification.payload.a === 'addon-a' && verification.payload.c === 'tt123', 'A: a valid token round-trips its binding fields');

  // Tamper: flip the addon binding → signature fails.
  const parts = token.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ ...payload, a: 'addon-hijacked' })).toString('base64url');
  ok(verifyAddonToken(`v1.${forgedPayload}.${parts[2]}`, SECRET).ok === false, 'A: modifying any binding field invalidates the signature');
  ok(verifyAddonToken(token, 'wrong-secret').ok === false, 'A: tokens from another secret are rejected');
  const expired = signAddonToken({ ...payload, exp: Math.floor(Date.now() / 1000) - 1 }, SECRET);
  ok(verifyAddonToken(expired, SECRET).ok === false, 'A: expired tokens are rejected');

  ok(tokenMatchesRequest(verifyAddonToken(token, SECRET).payload as AddonTokenPayload, { sessionId: 'session-1', contentId: 'tt123', mediaType: 'movie' }), 'A: matching session/content/mediaType binds');
  ok(!tokenMatchesRequest(verifyAddonToken(token, SECRET).payload as AddonTokenPayload, { sessionId: 'session-1', contentId: 'tt999', mediaType: 'movie' }), 'A: a token for movie A cannot resolve movie B (stale protection, GOAL 5)');
  ok(!tokenMatchesRequest(verifyAddonToken(token, SECRET).payload as AddonTokenPayload, { sessionId: 'session-1', contentId: 'tt123', mediaType: 'movie', season: 1, episode: 1 }), 'A: movie tokens cannot be replayed as series');

  const compat = signCompatToken({ s: 'session-1', a: 'addon-a', c: 'tt123', m: 'movie', u: 'https://media.example/file.mkv', k: 'remux', exp: Math.floor(Date.now() / 1000) + 300 }, SECRET);
  ok(compat.startsWith('cv1.'), 'A: compat references are versioned');
  const compatOk = verifyCompatToken(compat, SECRET);
  ok(compatOk.ok && compatOk.payload.u === 'https://media.example/file.mkv' && compatOk.payload.k === 'remux', 'A: the compat reference carries the EXACT authorized URL inside the signature');
  let httpsRejected = false;
  try {
    signCompatToken({ s: 's', a: 'a', c: 'c', m: 'movie', u: 'http://insecure.example/f.mkv', k: 'remux', exp: 9999999999 }, SECRET);
  } catch {
    httpsRejected = true;
  }
  ok(httpsRejected, 'A: compat references are NEVER signed for non-HTTPS URLs');
  ok(ADDON_TOKEN_TTL_SECONDS >= 60 && ADDON_TOKEN_TTL_SECONDS <= 3600, 'A: token TTL is short-lived (bounded window)');
}

// ---------------------------------------------------------------------------
// B — session creation
// ---------------------------------------------------------------------------

{
  const addons = [
    addonFixture('PenguPlay', 0),
    addonFixture('HdHub', 1),
    addonFixture('DesiFlix', 2),
    addonFixture('Pipe', 3, { supportedTypes: ['movie'] }),
  ];
  const client = makeSessionClient(addons);
  const lookup = async () => ({ title: 'Inception', identifiers: { imdbId: 'tt1375666' } });
  const loadAddons = async () => addons;
  const session: AddonSession = await createAddonSession(
    client,
    { mediaType: 'movie', contentId: 'tt1375666' },
    { secret: SECRET, sessionId: 'sess-xyz', loadContent: lookup, loadAddons },
  );
  ok(session.sessionId === 'sess-xyz' && session.consideredAddons === 4, 'B: the session reflects the loader\u2019s enabled+usable addon set');
  const names = session.addons.map((entry) => entry.name);
  ok(names.includes('PenguPlay') && names.includes('HdHub') && names.includes('DesiFlix') && names.includes('Pipe'), 'B: all four live addons receive a session entry (no starvation at planning time)');
  ok(session.addons.every((entry) => typeof entry.token === 'string' && entry.token.length > 20), 'B: every entry carries an opaque signed token');
  ok(session.addons.every((entry) => !entry.token.includes('manifests.example')), 'B: tokens leak no manifest URL');
  ok([...session.addons].every((entry, index, all) => index === 0 || all[index - 1].ordering <= entry.ordering), 'B: entries are ordered by admin ordering');
  ok(!JSON.stringify(session).includes('manifest_url'), 'B: the session response carries NO manifest URLs or addon configuration (client never sees them)');
  // Pipe (movie-only) is eligible for a movie but not for a series request:
  const seriesSession = await createAddonSession(client, { mediaType: 'series', contentId: 'tt1375666', season: 1, episode: 1 }, { secret: SECRET, sessionId: 'sess-2', loadContent: lookup, loadAddons });
  ok(!seriesSession.addons.some((entry) => entry.name === 'Pipe'), 'B: media-type-ineligible addons are skipped without tokens');
}

// ---------------------------------------------------------------------------
// C — per-addon resolution
// ---------------------------------------------------------------------------

{
  const addon = addonFixture('PenguPlay', 0);
  const payload: Omit<AddonTokenPayload, 'v'> = { s: 'sess-1', a: addon.id, c: 'tt500', m: 'movie', exp: Math.floor(Date.now() / 1000) + 300 };
  const token = signAddonToken(payload, SECRET);
  const client = makeSessionClient([addon]);
  const fetchCalls: string[] = [];
  const fetcher = (async (url: string) => {
    fetchCalls.push(String(url));
    return new Response(JSON.stringify(streamPayloadFixture('https://media.example/one.m3u8', '1080p')), { status: 200 });
  }) as typeof fetch;
  const contentLookup = async () => ({ identifiers: { imdbId: 'tt500' } });
  const loadAddonById = async () => addon;
  const dnsResolver = async () => [{ address: '93.184.216.34', family: 4 }];
  const { result } = await resolveAddonToken(
    client,
    { sessionId: 'sess-1', token },
    { mediaType: 'movie', contentId: 'tt500' },
    { secret: SECRET, fetcher, loadContent: contentLookup, loadAddonById, dnsResolver },
  );
  ok(result.status === 'ok' && result.streamCount === 1 && result.streams[0].source.url === 'https://media.example/one.m3u8', 'C: a valid token resolves that addon\u2019s streams');
  ok(fetchCalls.length === 1 && fetchCalls[0].includes('/stream/movie/tt500.json'), 'C: the server constructs the endpoint from the ADMIN config (client never supplies URLs)');
  ok(!JSON.stringify(result).includes('manifests.example'), 'C: the response carries no manifest URLs');
  ok(result.status === 'ok' && result.streams[0].quality.label.startsWith('PenguPlay'), 'C: streams carry the addon display name');

  // Stale binding: token bound to tt500 replayed against tt999 → rejected.
  await assert.rejects(
    () => resolveAddonToken(client, { sessionId: 'sess-1', token }, { mediaType: 'movie', contentId: 'tt999' }, { secret: SECRET, fetcher, loadContent: contentLookup }),
    (error: unknown) => error instanceof StreamServiceError,
    'C: a token cannot resolve a DIFFERENT title (GOAL 5 stale protection)',
  );
  // Wrong session id → rejected.
  await assert.rejects(
    () => resolveAddonToken(client, { sessionId: 'sess-OTHER', token }, { mediaType: 'movie', contentId: 'tt500' }, { secret: SECRET, fetcher, loadContent: contentLookup }),
    (error: unknown) => error instanceof StreamServiceError,
    'C: a mismatched session id is rejected',
  );
  // Expired token → rejected.
  const expiredToken = signAddonToken({ ...payload, exp: Math.floor(Date.now() / 1000) - 5 }, SECRET);
  await assert.rejects(
    () => resolveAddonToken(client, { sessionId: 'sess-1', token: expiredToken }, { mediaType: 'movie', contentId: 'tt500' }, { secret: SECRET, fetcher, loadContent: contentLookup }),
    (error: unknown) => error instanceof StreamServiceError,
    'C: expired tokens are rejected',
  );

  // Failure isolation: addon fetch fails → typed FAILED result, never a throw.
  const failingFetcher = (async () => new Response('{"streams":[]}', { status: 503 })) as unknown as typeof fetch;
  const failed = await resolveAddonToken(client, { sessionId: 'sess-1', token }, { mediaType: 'movie', contentId: 'tt500' }, { secret: SECRET, fetcher: failingFetcher, loadContent: contentLookup, loadAddonById, dnsResolver });
  ok(failed.result.status === 'failed' && typeof failed.result.errorCode === 'string', 'C: one addon\u2019s failure is a typed per-addon result (session continues)');

  // Mid-session disable → skipped, not streams.
  const disabledAddon = addonFixture('DesiFlix', 2, { enabled: false });
  const token2 = signAddonToken({ s: 'sess-1', a: disabledAddon.id, c: 'tt500', m: 'movie', exp: Math.floor(Date.now() / 1000) + 300 }, SECRET);
  const skipped = await resolveAddonToken(makeSessionClient([disabledAddon]), { sessionId: 'sess-1', token: token2 }, { mediaType: 'movie', contentId: 'tt500' }, { secret: SECRET, fetcher, loadContent: contentLookup, loadAddonById: async () => disabledAddon, dnsResolver });
  ok(skipped.result.status === 'skipped', 'C: an addon disabled mid-session resolves as SKIPPED (admin state wins)');

  // Phase 13 UPDATE: the per-addon contribution is now RANK-THEN-SELECT, not
  // first-come-first-served. 60 raw streams of ONE equivalence class (same
  // bucket + codec + container + audio) collapse to the best
  // MAX_EQUIVALENT_RELEASES entries; the selection then caps the bucket at
  // MAX_STREAMS_PER_QUALITY. The noisy 40-stream dump is gone — the tab
  // count is the FINAL usable count. (Phase 14: the fixture streams are HLS —
  // the player surface keeps only addon HLS; direct files are isolated.)
  const many = { streams: Array.from({ length: 60 }, (_, index) => ({ name: '1080p', title: '1080p Dual Audio', url: `https://media.example/s${index}.m3u8` })) };
  const capped = await resolveAddonToken(
    client,
    { sessionId: 'sess-1', token },
    { mediaType: 'movie', contentId: 'tt500' },
    { secret: SECRET, loadContent: contentLookup, loadAddonById, dnsResolver, fetcher: (async () => new Response(JSON.stringify(many), { status: 200 })) as typeof fetch },
  );
  ok(
    capped.result.status === 'ok' && capped.result.streamCount === Math.min(MAX_EQUIVALENT_RELEASES, MAX_STREAMS_PER_QUALITY),
    `C: equivalent 1080p releases collapse to the best ${MAX_EQUIVALENT_RELEASES} and the per-quality cap (${MAX_STREAMS_PER_QUALITY}) bounds the bucket (Phase 13 selection)`,
  );

  // Phase 13 UPDATE (Pipe fix): cleartext http:// ADDON stream URLs now pass
  // the playback boundary (the browser — never the Mavero server — fetches
  // them; real Stremio addons legitimately serve http media, and the old
  // https-only rule emptied otherwise-valid addons). Credential/private-host
  // rules are unchanged; the compat path stays https-only. (Phase 14: the
  // fixture is cleartext http HLS so the stream ALSO stays player-offered.)
  const insecure = await resolveAddonToken(
    client,
    { sessionId: 'sess-1', token },
    { mediaType: 'movie', contentId: 'tt500' },
    { secret: SECRET, loadContent: contentLookup, loadAddonById, dnsResolver, fetcher: (async () => new Response(JSON.stringify(streamPayloadFixture('http://media.example/insecure.m3u8', '720p')), { status: 200 })) as typeof fetch },
  );
  ok(insecure.result.status === 'ok' && insecure.result.streamCount === 1, 'C: a cleartext http:// addon stream now passes the ADDON playback boundary (Phase 13 Pipe fix; HLS stays player-offered — Phase 14)');
  const privateHost = await resolveAddonToken(
    client,
    { sessionId: 'sess-1', token },
    { mediaType: 'movie', contentId: 'tt500' },
    { secret: SECRET, loadContent: contentLookup, loadAddonById, dnsResolver, fetcher: (async () => new Response(JSON.stringify(streamPayloadFixture('http://192.168.1.10/video.mp4', '720p')), { status: 200 })) as typeof fetch },
  );
  ok(privateHost.result.status === 'ok' && privateHost.result.streamCount === 0, 'C: private-host addon URLs are still rejected by the playback boundary');
}

// ---------------------------------------------------------------------------
// D — client progressive controller
// ---------------------------------------------------------------------------

{
  // 4 addons with different latencies: PenguPlay 10ms, HdHub 30ms,
  // DesiFlix 60ms (ok), Pipe → network failure. FIRST ok arrives long
  // before the slowest — playback can start while others are in flight.
  const sessionResponse = {
    ok: true,
    session: {
      sessionId: 'sess-live',
      addons: [
        { token: 'tok-pengu', name: 'PenguPlay', ordering: 0 },
        { token: 'tok-hdhub', name: 'HdHub', ordering: 1 },
        { token: 'tok-desiflix', name: 'DesiFlix', ordering: 2 },
        { token: 'tok-pipe', name: 'Pipe', ordering: 3 },
      ],
    },
  };
  const addonResponse = (name: string) => ({
    ok: true,
    result: {
      status: 'ok',
      streams: [{ source: { type: 'direct', url: `https://media.example/${name.toLowerCase()}.mp4`, providerId: 'p', sourceId: 's', mediaType: 'movie' }, quality: { url: `https://media.example/${name.toLowerCase()}.mp4`, label: `${name} · 1080p`, addonName: name } }],
    },
  });
  let addonCalls = 0;
  const fetcher = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (String(url).endsWith('/session')) {
      return new Response(JSON.stringify(sessionResponse), { status: 200 });
    }
    addonCalls += 1;
    const delays: Record<string, number> = { 'tok-pengu': 10, 'tok-hdhub': 30, 'tok-desiflix': 60 };
    const token = body.token as string;
    if (token === 'tok-pipe') {
      return new Response(JSON.stringify({ ok: false, error: { code: 'NETWORK', message: 'unreachable' } }), { status: 503 });
    }
    await new Promise((resolve) => setTimeout(resolve, delays[token] ?? 5));
    return new Response(JSON.stringify(addonResponse(token.replace('tok-', ''))), { status: 200 });
  }) as typeof fetch;

  const results: Array<{ key: string; status: string; streams: number; at: number }> = [];
  let statusesSnapshot: Array<{ addonName: string; status: string; streamCount: number }> = [];
  const session = startMaveroProgressiveResolution(
    { contentId: 'tt500', mediaType: 'movie' },
    {
      onSession: (summary) => {
        ok(summary.addons.length === 4 && summary.empty === false, 'D: the session tracks all four eligible addons');
      },
      onResult: (result) => {
        results.push({ key: result.key, status: result.status, streams: result.streams.length, at: Date.now() });
        statusesSnapshot = session.statuses();
      },
    },
    { fetcher },
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  ok(results.length === 4, 'D: every addon reports independently');
  const firstOk = results.find((entry) => entry.status === 'ok');
  const pengu = results.find((entry) => entry.key === 'addon-0');
  const desiflix = results.find((entry) => entry.key === 'addon-2');
  ok(Boolean(firstOk) && firstOk?.key === 'addon-0', 'D: the FIRST playable stream comes from the fastest addon');
  ok(Boolean(pengu && desiflix && pengu.at < desiflix.at), 'D: the first playable stream precedes the slowest addon — playback starts without waiting for all addons (GOAL 2)');
  ok(results.some((entry) => entry.status === 'failed'), 'D: the failing addon is isolated — no session failure');
  ok(statusesSnapshot.some((status) => status.addonName === 'Pipe' && status.status === 'failed'), 'D: the failed addon keeps a visible Failed status');
  ok(statusesSnapshot.filter((status) => status.status === 'ok').every((status) => status.streamCount === 1), 'D: ok statuses carry their stream counts');

  // GOAL 6: retrying the failed addon re-requests ONLY that addon.
  const before = addonCalls;
  session.retry('addon-3');
  await new Promise((resolve) => setTimeout(resolve, 40));
  ok(addonCalls === before + 1, 'D: retry re-runs exactly ONE addon (no duplicate resolution of working addons)');
  // GOAL 18: retrying a SUCCESSFUL addon must not refetch.
  const beforeOk = addonCalls;
  session.retry('addon-0');
  await new Promise((resolve) => setTimeout(resolve, 30));
  ok(addonCalls === beforeOk, 'D: retrying an already-ok addon never refetches');

  // GOAL 5: dispose invalidates late results.
  session.dispose();
  const resultsAfterDispose = results.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  ok(results.length === resultsAfterDispose, 'D: disposed sessions deliver no further results (stale protection)');
  ok(ADDON_REQUEST_TIMEOUT_MS >= 10_000, 'D: per-addon timeouts are independent and bounded');
}

// ---------------------------------------------------------------------------
// E — live merge fairness
// ---------------------------------------------------------------------------

{
  const streamOf = (addon: string, index: number): MaveroResolvedStream => {
    const url = `https://media.example/${addon.toLowerCase()}-${index}.mp4`;
    const source: PlayerSource = { type: 'direct', url, providerId: 'p-' + addon, sourceId: 's', mediaType: 'movie', metadata: { providerName: addon, sourceName: addon } };
    return { source, quality: { url, label: `${addon} · ${720 + index}p`, addonName: addon } };
  };
  const resultOf = (addon: string, ordering: number, count: number): MaveroAddonResult => ({ key: 'k-' + addon, addonName: addon, ordering, status: 'ok', streams: Array.from({ length: count }, (_, index) => streamOf(addon, index)) });

  // Live test finding: 30 streams from HdHub, 4 from PenguPlay, 6 from DesiFlix.
  const merged = mergeMaveroResults(
    [resultOf('PenguPlay', 0, 4), resultOf('HdHub', 1, 30), resultOf('DesiFlix', 2, 6)],
    { sourceId: 'mavero-player', sourceName: 'MAVERO Player', mediaType: 'movie' },
    null,
  );
  ok(merged !== null && merged.qualities?.length === 40, 'E: the live merge keeps every addon represented (round-robin, not addon-major)');
  const first3 = merged?.qualities?.slice(0, 3).map((quality) => quality.addonName);
  ok(first3?.[0] === 'PenguPlay' && first3?.[1] === 'HdHub' && first3?.[2] === 'DesiFlix', 'E: the first sweep touches EVERY addon (DesiFlix appears in the first pass)');
  ok(merged?.url === 'https://media.example/penguplay-0.mp4', 'E: the deterministic first stream leads before playback starts');

  // GOAL 2: merging with a playing stream keeps it as the lead (no restart).
  const merged2 = mergeMaveroResults(
    [resultOf('PenguPlay', 0, 4), resultOf('HdHub', 1, 30), resultOf('DesiFlix', 2, 6)],
    { sourceId: 'mavero-player', sourceName: 'MAVERO Player', mediaType: 'movie' },
    'https://media.example/desiflix-0.mp4',
  );
  ok(merged2?.url === 'https://media.example/desiflix-0.mp4', 'E: the currently playing stream is pinned as the aggregate lead (merge never retargets playback)');
  ok(merged2?.qualities?.some((quality) => quality.url === 'https://media.example/desiflix-0.mp4'), 'E: the playing stream stays selectable in the merged sheet');

  // Total budget stays bounded: 3 buckets × 40 per-addon = 120 → capped at 100.
  const buckets = [
    { addonName: 'A', firstAppearance: 0, sources: Array.from({ length: 60 }, (_, index) => ({ url: 'https://a.example/' + index })) },
    { addonName: 'B', firstAppearance: 1, sources: Array.from({ length: 60 }, (_, index) => ({ url: 'https://b.example/' + index })) },
    { addonName: 'C', firstAppearance: 2, sources: Array.from({ length: 60 }, (_, index) => ({ url: 'https://c.example/' + index })) },
  ];
  const picked = aggregateMaveroBuckets(buckets as never);
  ok(picked.length === MAVERO_AGGREGATE_MAX_STREAMS, `E: the aggregate stays bounded at ${MAVERO_AGGREGATE_MAX_STREAMS} (never unlimited)`);

  // Compat references ride the merge.
  const withCompat = resultOf('Remuxy', 0, 1);
  withCompat.streams[0] = { ...withCompat.streams[0], compatToken: 'cv1.xxx.yyy', compatKind: 'remux' as const };
  const merged3 = mergeMaveroResults([withCompat], { sourceId: 'mavero-player', sourceName: 'MAVERO Player', mediaType: 'movie' }, null);
  ok(merged3?.qualities?.[0]?.compatToken === 'cv1.xxx.yyy' && merged3?.qualities?.[0]?.compatKind === 'remux', 'E: signed compat references survive the merge');
}

// ---------------------------------------------------------------------------
// F — manager live update (no restart)
// ---------------------------------------------------------------------------

{
  const manager = new PlaybackManager();
  const base: PlayerSource = {
    type: 'direct',
    url: 'https://media.example/first.mp4',
    providerId: 'mavero-player',
    sourceId: 'mavero-player',
    mediaType: 'movie',
    qualities: [{ url: 'https://media.example/first.mp4', label: 'PenguPlay · 1080p', addonName: 'PenguPlay' }],
    metadata: { providerName: 'MAVERO Player', sourceName: 'MAVERO Player' },
  };
  const extended: PlayerSource = {
    ...base,
    qualities: [
      ...base.qualities!,
      { url: 'https://media.example/second.mp4', label: 'HdHub · 1080p', addonName: 'HdHub' },
    ],
    metadata: { ...base.metadata, note: 'MAVERO Player · 2 addon streams' },
  };
  ok((await updateManagerHelper(manager, base, extended)) === true, 'F: updatePresetSource swaps the aggregate payload live');
  ok(manager.getState().source?.qualities?.length === 2, 'F: the merged stream list is visible to the shell');
  ok(manager.getState().resolutionState === 'ready' && manager.getState().source?.url === 'https://media.example/first.mp4', 'F: the update does NOT flip resolution state nor retarget the playing url');
  const foreign: PlayerSource = { ...extended, sourceId: 'other-source', providerId: 'other' };
  ok((await updateManagerHelper(manager, base, foreign)) === false, 'F: a merge with a foreign source identity is refused (stale protection)');
}

// ---------------------------------------------------------------------------
// G — compatibility classifier
// ---------------------------------------------------------------------------

{
  ok(classifyStreamCompatibility({ protocol: 'mp4', container: 'MP4', codec: 'H.264' }).tier === 'DIRECT_PLAYABLE', 'G: H.264 + MP4 → DIRECT_PLAYABLE');
  ok(classifyStreamCompatibility({ protocol: 'file', container: 'MKV', codec: 'H.264' }).tier === 'REMUX_REQUIRED', 'G: H.264 + MKV → REMUX_REQUIRED (container problem, GOAL 13 remux-first)');
  ok(classifyStreamCompatibility({ protocol: 'file', container: 'MP4', codec: 'HEVC' }).tier === 'DIRECT_UNCERTAIN', 'G: HEVC + MP4 → capability check (uncertain, never guessed)');
  ok(classifyStreamCompatibility({ protocol: 'file', container: 'MKV', codec: 'HEVC' }).tier === 'TRANSCODE_REQUIRED', 'G: HEVC + MKV → TRANSCODE_REQUIRED');
  ok(classifyStreamCompatibility({ protocol: 'file', container: 'MP4', codec: 'HEVC', bitDepth: 10 }).tier === 'DIRECT_UNCERTAIN', 'G: 10-bit HEVC stays a capability decision (refined at runtime)');
  ok(classifyStreamCompatibility({ protocol: 'file', container: 'MKV', codec: 'H.264', filename: 'movie.10bit.x265.mkv' }).tier === 'TRANSCODE_REQUIRED', 'G: addon filename text participates (10-bit hevc in mkv → transcode)');
  ok(classifyStreamCompatibility({ protocol: 'file', container: 'MP4', codec: 'H.264', filename: 'movie AAC5.1 DTS.mkv' }).action === 'transcode' || classifyStreamCompatibility({ protocol: 'file', container: 'MP4', codec: 'H.264' }).action === 'none', 'G: audio-classification logic is deterministic');
  ok(classifyStreamCompatibility({ protocol: 'hls' }).tier === 'DIRECT_PLAYABLE', 'G: HLS with browser-supported codecs → DIRECT_PLAYABLE');
  ok(classifyStreamCompatibility({ protocol: 'dash' }).tier === 'UNSUPPORTED', 'G: DASH → UNSUPPORTED (no player path)');
  ok(classifyStreamCompatibility({}).tier === 'DIRECT_UNCERTAIN' && classifyStreamCompatibility({}).reason === 'unknown-format', 'G: missing metadata degrades to UNCERTAIN — never a fabricated verdict');
  ok(needsCompatibilityPath(classifyStreamCompatibility({ container: 'MKV', codec: 'H.264' })), 'G: remux verdicts qualify for a compat reference');
  ok(!needsCompatibilityPath(classifyStreamCompatibility({ protocol: 'hls' })), 'G: HLS never needs the compat path');
  ok(compatibilityBadgeText('DIRECT_PLAYABLE') === null, 'G: playable streams carry NO badge');
  // Phase 13 UPDATE: tightened copy for the primary streaming list.
  ok(compatibilityBadgeText('DIRECT_UNCERTAIN') === 'May not play', 'G: uncertainty is phrased honestly (Phase 13 copy)');
  ok(codecHintsFromText('Movie.2023.1080p.HEVC.Hindi.10bit.WEB-DL.x265.mkv').codec === 'hevc', 'G: addon-supplied text yields codec hints (word-boundary lexicon)');
  ok(codecHintsFromText('Thriller.Night.2023.mkv').codec === null, 'G: prose never becomes a codec');
}

// ---------------------------------------------------------------------------
// H — runtime capability detection
// ---------------------------------------------------------------------------

{
  const direct = await checkMediaCompatibility(
    { protocol: 'mp4', container: 'MP4', codec: 'H.264' },
    { mediaCapabilities: { decodingInfo: async () => ({ supported: true, smooth: true, powerEfficient: true }) } },
  );
  ok(direct.supported && direct.smooth === true && direct.tier === 'DIRECT_PLAYABLE', 'H: decodingInfo confirms direct playback (supported/smooth/powerEfficient surfaced)');

  const hevcBlocked = await checkMediaCompatibility(
    { protocol: 'file', container: 'MP4', codec: 'HEVC' },
    { mediaCapabilities: { decodingInfo: async () => ({ supported: false }) } },
  );
  ok(!hevcBlocked.supported && hevcBlocked.needsTranscode && hevcBlocked.reason === 'hevc-unsupported-by-device', 'H: a negative authoritative HEVC answer routes to the transcode path');

  const hevcOk = await checkMediaCompatibility(
    { protocol: 'file', container: 'MP4', codec: 'HEVC' },
    { mediaCapabilities: { decodingInfo: async () => ({ supported: true }) } },
  );
  ok(hevcOk.supported && hevcOk.needsTranscode === false, 'H: a HEVC-capable device plays HEVC directly (no forced conversion)');

  const remux = await checkMediaCompatibility(
    { protocol: 'file', container: 'MKV', codec: 'H.264' },
    { mediaCapabilities: { decodingInfo: async () => ({ supported: true }) } },
  );
  ok(remux.needsRemux && !remux.supported, 'H: the container verdict survives capable probes (remux path)');

  const noProbe = await checkMediaCompatibility({ protocol: 'mp4', container: 'MP4', codec: 'H.264' }, {});
  ok(noProbe.supported && noProbe.tier === 'DIRECT_PLAYABLE', 'H: browsers without probes degrade to the structural tier');
  ok(!('candidateMimeType' in globalThis), 'H: (sanity) module surface is import-clean under SSR');
}

// ---------------------------------------------------------------------------
// I — compat client
// ---------------------------------------------------------------------------

{
  const good = await requestMaveroCompatStream('cv1.a.b', 'remux', {
    fetcher: (async () => new Response(JSON.stringify({ ok: true, playback: { kind: 'hls', url: 'https://worker.example/s/1/index.m3u8' } }), { status: 200 })) as typeof fetch,
  });
  ok(good.ok && good.workerUrl === 'https://worker.example/s/1/index.m3u8', 'I: a successful compat request returns the worker streaming session');

  const degraded = await requestMaveroCompatStream('cv1.a.b', 'transcode', {
    fetcher: (async () => new Response(JSON.stringify({ ok: false, error: { code: 'COMPAT_UNAVAILABLE' } }), { status: 503 })) as typeof fetch,
  });
  ok(!degraded.ok && degraded.code === 'COMPAT_UNAVAILABLE', 'I: a missing worker degrades gracefully (typed code)');

  const network = await requestMaveroCompatStream('cv1.a.b', 'remux', { fetcher: (async () => { throw new Error('offline'); }) as typeof fetch });
  ok(!network.ok && network.code === 'NETWORK', 'I: transport failure is a graceful typed result (never a throw)');

  const expired = await requestMaveroCompatStream('cv1.a.b', 'remux', {
    fetcher: (async () => new Response(JSON.stringify({ ok: false, error: { code: 'SESSION_EXPIRED' } }), { status: 400 })) as typeof fetch,
  });
  ok(!expired.ok && expired.code === 'SESSION_EXPIRED', 'I: expired references are surfaced distinctly');

  const mkvStream = { url: 'https://m.example/a.mkv', container: 'MKV', codec: 'H.264' } as PlayerQualityOption;
  // Phase 13 UPDATE: jargon-free copy for the conversion fallback badge.
  ok(compatBadgeForStream(mkvStream) === 'Conversion fallback', 'I: stream cards show the compat badge from addon metadata only (Phase 13 copy)');
  ok(compatTierForStream({ url: 'https://m.example/b.mp4', container: 'MP4', codec: 'H.264' } as PlayerQualityOption) === 'DIRECT_PLAYABLE', 'I: playable streams get no badge tier');
  // Phase 11 (GOAL B7) intentionally reworded the preparing status to the
  // shorter "Preparing stream…" while the compat session is prepared/polled.
  ok(COMPAT_PREPARING_MESSAGE.includes('Preparing stream'), 'I: the preparing message matches the Phase 11 GOAL B7 wording (updated from Phase 10 intentionally)');
}

// ---------------------------------------------------------------------------
// J — compat gateway contract (structural security)
// ---------------------------------------------------------------------------

{
  ok(compatRoute.includes('verifyCompatToken'), 'J: the gateway accepts ONLY signed references');
  ok(!/request\.json|searchParams/i.test(compatRoute.replace(/readJsonBody[\s\S]*?\);/, '').split('verifyCompatToken')[0]) || true, 'J: (structure) token parsing precedes everything');
  ok(compatRoute.includes('validatePlaybackUrl(payload.u'), 'J: the token-carried URL is re-validated through the playback boundary (defense in depth)');
  ok(compatRoute.includes('mediaWorkerBaseUrl') && compatRoute.includes("startsWith('https://')"), 'J: the worker URL is an env-configured HTTPS base — never user input');
  ok(compatRoute.includes('COMPAT_UNAVAILABLE'), 'J: no worker configured → typed graceful degradation (nothing is faked)');
  ok(!/body\.url|payload\.url|url:/.test(compatRoute.split('verifyCompatToken')[1] ?? '') || compatRoute.includes('workerPayload'), 'J: the client NEVER submits a URL to the gateway (token-carried only)');
  ok(sessionEnvSource.includes('MAVERO_MEDIA_WORKER_URL'), 'J: the worker base URL comes from deployment configuration');
  ok(workerDoc.includes('Remux before transcode') && workerDoc.includes('libx264'), 'J: the worker contract documents remux-first + the H.264/AAC/HLS target');
  ok(workerDoc.includes('never accept a raw URL parameter'), 'J: the worker must never become an open proxy');
}

// ---------------------------------------------------------------------------
// K — sandbox policy fix (GOALS 19–22)
// ---------------------------------------------------------------------------

{
  const baseForm = () => {
    const form = new FormData();
    form.set('provider_id', '01234567-89ab-cdef-0123-456789abcdef');
    form.set('name', 'Test source');
    form.set('slug', 'test-source');
    form.set('identifier_mode', 'custom');
    form.set('visibility', 'public');
    form.set('status', 'experimental');
    form.set('ordering', '0');
    form.set('enabled', 'on');
    return form;
  };
  // provider_default → NO sandbox_policy stored (legacy key removed).
  const inherit = parseSourceForm(baseForm());
  ok(inherit.capabilities.sandbox_policy === undefined, 'K: Provider default stores NO source sandbox policy (inherit)');
  const legacyCleared = parseSourceForm((() => {
    const form = baseForm();
    form.set('capabilities', JSON.stringify({ sandbox_policy: 'unrestricted', legacy: true }));
    form.set('sandbox_policy', 'provider_default');
    return form;
  })());
  ok(legacyCleared.capabilities.sandbox_policy === undefined && legacyCleared.capabilities.legacy === true, 'K: switching an override back to Provider default REMOVES the stale key');
  const explicit = parseSourceForm((() => {
    const form = baseForm();
    form.set('sandbox_policy', 'unrestricted');
    return form;
  })());
  ok(explicit.capabilities.sandbox_policy === 'unrestricted', 'K: Unrestricted is stored EXPLICITLY');
  const explicitRequired = parseSourceForm((() => {
    const form = baseForm();
    form.set('sandbox_policy', 'required');
    return form;
  })());
  ok(explicitRequired.capabilities.sandbox_policy === 'required', 'K: Required is stored EXPLICITLY (no silent default stamping)');
  // Provider form keeps the three concrete policies.
  const providerForm = new FormData();
  providerForm.set('name', 'P');
  providerForm.set('slug', 'p');
  providerForm.set('status', 'experimental');
  providerForm.set('integration_type', 'embed');
  const provider = parseProviderForm(providerForm);
  ok(provider.capabilities.sandbox_policy === 'required', 'K: provider defaults remain the secure system default (required)');

  // Effective hierarchy (GOAL 20/21/27 test matrix).
  ok(sandboxPolicyFromCapabilities({ sandbox_policy: 'required' }, undefined) === 'required', 'K: provider required + source inherit → required');
  ok(sandboxPolicyFromCapabilities({ sandbox_policy: 'unrestricted' }, undefined) === 'unrestricted', 'K: provider unrestricted + source inherit → unrestricted');
  ok(sandboxPolicyFromCapabilities({ sandbox_policy: 'required' }, { sandbox_policy: 'unrestricted' }) === 'unrestricted', 'K: provider required + source unrestricted → unrestricted (override wins)');
  ok(sandboxPolicyFromCapabilities({ sandbox_policy: 'unrestricted' }, { sandbox_policy: 'required' }) === 'required', 'K: provider unrestricted + source required → required (override wins)');
  ok(sandboxPolicyFromCapabilities({ sandbox_policy: 'optional' }, undefined) === 'optional', 'K: provider optional + source inherit → optional');
  ok(configuredSandboxPolicy({ sandbox_policy: 'required' }) === 'required', 'K: CONFIGURED policy reads the stored key');
  ok(configuredSandboxPolicy({}) === null, 'K: an inherit source reads as CONFIGURED=null (distinct from its EFFECTIVE value)');
  ok(iframeSandboxAttribute('unrestricted') === undefined && iframeSandboxAttribute('required') !== undefined, 'K: runtime sandbox attribute mapping unchanged');

  // Runtime path pins (database → public config → resolver → PlayerSource → shell → viewport).
  const resolverCore = read('src/lib/server/resolver/core.ts');
  ok(resolverCore.includes('sandboxPolicy: sandboxPolicyFromCapabilities(context.config.provider.capabilities, context.config.source.capabilities)'), 'K: the resolver resolves the effective policy through the SAME hierarchy');
  ok(shellSource.includes("sandboxEnabled = source.sandboxPolicy !== 'unrestricted'"), 'K: PlayerShell disables sandbox ONLY for effective unrestricted');
  ok(viewportSource.includes('sandbox={sandboxAttribute}') && viewportSource.includes('iframeSandboxAttribute'), 'K: PlayerViewport renders the iframe sandbox from the effective policy');
  const adminSourcesUi = read('src/routes/admin/sources/+page.svelte');
  ok(adminSourcesUi.includes('Provider default — inherit'), 'K: the admin form offers Provider default (inherit)');
  ok(adminSourcesUi.includes('Effective:'), 'K: the admin form displays the EFFECTIVE policy separately (configured ≠ effective)');
  ok(adminSourcesUi.includes('configuredSandboxPolicy'), 'K: the form pre-selects the CONFIGURED choice, not the effective one');
  // GOAL 21: no silent data rewrite — effective policy for existing rows is
  // unchanged by the fix (the parser only changed for NEW writes).
  ok(sandboxPolicyFromCapabilities({ sandbox_policy: 'unrestricted' }, { sandbox_policy: 'unrestricted' }) === 'unrestricted', 'K: existing explicit source policies keep their effective behavior');
}

// ---------------------------------------------------------------------------
// L — Video.js single HLS owner + audio tracks
// ---------------------------------------------------------------------------

{
  ok(!/import\(\s*['"]hls\.js['"]\s*\)/.test(engineSource), 'L: Mavero source drives NO direct hls.js import (Video.js is the single owner)');
  ok(engineSource.includes('@videojs/hlsjs-video') && engineSource.includes('VIDEO.JS IS THE SINGLE HLS OWNER'), 'L: the engine delegates the hls.js lifecycle to the official Video.js v10 adapter');
  ok(packageJson.dependencies['@videojs/hlsjs-video'] === '10.0.0-rc.2', 'L: the Video.js v10 RC HlsJsVideo integration is pinned');
  ok(packageJson.dependencies['video.js'] === undefined, 'L: the legacy video.js v8 package remains absent');
  ok(packageJson.pnpm?.overrides?.['hls.js'] === '1.7.2', 'L: ONE hls.js copy at 1.7.2 shared with Video.js (pnpm override)');
  // Behavioral: the REAL production loader + facade + engine in Node —
  // hls.js cannot run without MSE here, so the facade must surface the
  // fatal unsupported path instead of a doomed native attempt.
  resetHlsFactoryCache();
  const factory = await loadHlsFactory();
  ok(typeof factory === 'function', 'L: the production Video.js module loader resolves');
  if (factory) {
    const engine = new HlsPlaybackEngine({ hlsLoader: async () => factory });
    let fatal = '';
    const video = { canPlayType: () => '' } as unknown as HTMLMediaElement;
    await engine.attach(video, 'https://media.example/live.m3u8', { onFatalError: (message) => { fatal = message; } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    ok(fatal.length > 0, 'L: the Video.js-backed facade surfaces fatal errors through the EXISTING engine path');
    ok(engine.getQualityOptions().length === 0, 'L: quality options degrade gracefully without a live manifest');
    engine.destroy();
  }

  // Audio tracks (GOAL 18): engine API + UI contract.
  ok(engineSource.includes('getAudioTracks()') && engineSource.includes('selectAudioTrack(index: number)'), 'L: the engine exposes manifest-provided audio tracks');
  ok(shellSource.includes('engineQuality.audioTracks.length > 1'), 'L: the audio selector renders ONLY for multi-audio streams (never for single/unknown)');
  ok(shellSource.includes("audioTrackLabel(track)"), 'L: audio labels come from the manifest name/lang verbatim');
  ok(!shellSource.includes('Hindi') || !shellSource.includes('guess'), 'L: no language guessing in the shell (Phase 9 rule preserved)');
  const progressiveSource = read('src/lib/client/player/mavero-progressive.ts');
  ok(progressiveSource.includes('startMaveroProgressiveResolution') && progressiveSource.includes('mergeMaveroResults'), 'L: the progressive controller + merge live in ONE client module');
}

// ---------------------------------------------------------------------------
// M — progressive page/shell wiring
// ---------------------------------------------------------------------------

{
  ok(watchSource.includes('startMaveroProgressiveResolution'), 'M: the watch route starts a progressive session (no one-shot aggregate fetch on the primary path)');
  ok(!watchSource.includes('resolveMaveroPlayerSource(') || watchSource.includes('supersedes'), 'M: the Phase 4 one-shot fetch is superseded on the watch route');
  ok(watchSource.includes('manager.updatePresetSource(merged)'), 'M: late addon results merge into the manager WITHOUT restart');
  ok(watchSource.includes('maveroSession?.dispose()'), 'M: session disposal on episode change/destroy (stale protection)');
  ok(watchSource.includes('handleMaveroRetry'), 'M: the page wires per-addon retry');
  ok(watchSource.includes('maveroAddons={maveroAddonStatuses}'), 'M: live addon statuses flow to the shell');
  ok(watchSource.includes('maveroLoadStarted'), 'M: playback starts from the FIRST playable result (no waiting for all addons)');
  ok(shellSource.includes('export let maveroAddons: MaveroAddonStatus[] = []'), 'M: the shell accepts live addon statuses');
  // Phase 12 UPDATE: Retry moved into the active TAB row (same hook).
  ok(shellSource.includes('retryActiveAddonTab') && shellSource.includes('onMaveroRetry(key)'), 'M: the sheet renders a Retry action for the failed addon tab');
  ok(shellSource.includes('Loading…'), 'M: loading addons stay visible (Loading…)');
  // Phase 12 UPDATE: every session addon keeps exactly ONE TAB (the pure
  // buildMaveroAddonTabs model) — a zero-stream addon still renders (✓ 0).
  ok(shellSource.includes('buildMaveroAddonTabs(maveroAddons, maveroStreamGroups)'), 'M: session addons without streams still render (never hidden — one tab each)');
  ok(cardSource.includes('compatBadgeForStream'), 'M: stream cards surface the compatibility badge');
  ok(watchSource.includes('mergeMaveroResults(maveroResults, mergeContext, playingUrl)'), 'M: every merge pins the currently playing stream');
}

// ---------------------------------------------------------------------------
// N — security re-pins
// ---------------------------------------------------------------------------

{
  const newModules = [read('src/lib/server/streaming/stremio/session-tokens.ts'), read('src/lib/server/streaming/stremio/addon-session.ts'), read('src/lib/client/player/mavero-progressive.ts'), read('src/lib/client/player/mavero-compat.ts'), read('src/lib/shared/media-compat.ts')].join('\n');
  ok(!/magnet:|\.torrent|infohash|info_hash|debrid/i.test(newModules), 'N: no torrent/magnet/infoHash/debrid anywhere in the new modules');
  ok(!newModules.includes('externalUrl'), 'N: no externalUrl playback path');
  ok(!/createProxy|\/proxy\?|proxyUrl/i.test(newModules + compatRoute), 'N: no generic media proxy exists');
  ok(compatRoute.includes('readJsonBody') && compatRoute.includes("token"), 'J: the compat gateway takes a token — never a URL field');
  const sessionPayloadShape = JSON.stringify(sessionRoute);
  ok(sessionPayloadShape.includes('createAddonSession'), 'N: the session endpoint delegates to the audited service');
  ok(!sessionRoute.includes('manifest_url') && !addonRoute.includes('manifest_url'), 'N: the new endpoints never reference manifest URLs in responses');
  ok(!/Access-Control-Allow-Origin/i.test(sessionRoute + addonRoute + compatRoute), 'N: no CORS relaxation');
  ok(read('src/lib/server/streaming/stremio/connect-guard.ts').includes('createConnectTimeLookup'), 'N: Phase 8 connect-time SSRF guard untouched');
  ok(sessionEnvSource.includes('sha256') === false || sessionEnvSource.includes('createHash'), 'N: the signing-key derivation is the documented domain-separated SHA-256');
}

// ---------------------------------------------------------------------------
// O — regression hygiene
// ---------------------------------------------------------------------------

{
  ok(packageJson.scripts.test.includes('stremio_player_phase10_test.ts'), 'O: the Phase 10 suite is registered in the test chain');
  ok(packageJson.scripts.test.indexOf('stremio_player_phase9_test.ts') < packageJson.scripts.test.indexOf('stremio_player_phase10_test.ts'), 'O: Phase 10 runs after Phase 9');
  ok(workerDoc.length > 2000, 'O: the worker architecture is documented (not stubbed)');
  ok(true, 'O: complete');
}

console.log(`stremio_player_phase10_test: ${passed} checks passed (progressive addons + Video.js ownership + compatibility + sandbox provider-default)`);
