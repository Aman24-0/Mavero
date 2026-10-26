import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildVdrkListUrl,
  createExternalSubtitleController,
  externalSubtitlesKey,
  mergeSubtitleTracks,
  parseVdrkEntries,
  vdrkFileToProxyPath,
  VDRK_LIST_ORIGIN,
  VDRK_VTT_ORIGIN,
} from '$lib/client/player/subtitles/external-subtitles';
import {
  buildUpstreamVttUrl,
  clearVttCacheForTests,
  fetchUpstreamVttText,
  validateLabelParam,
  validatePositiveIntParam,
  validateTmdbIdParam,
} from '$lib/server/subtitles/vdrk';
import { createIntroLookup, validateIntroSegments } from '$lib/client/player/intro/intro-client';
import type { NormalizedSegmentTimestamp } from 'theintrodb';

// Player UI V2 — Part 1, PHASE 3 regression suite (external subtitles + skip intro).
//
// §1  VDRK client — URL validation/rewriting, list parsing, merge/dedup,
//     controller behavior (cache, dedup, stale keys, failure classes).
// §2  VDRK server module — segment validation, fixed upstream URL building,
//     bounded upstream fetch (content-type, size cap, timeout), route contracts.
// §3  TheIntroDB — segment validation truth table, multiple segments, missing
//     data, invalid ranges, negative backoff, stale keys, durationMs forwarding.
// §4  Shell + route contracts — media-scoped lookups, playhead-gated Skip Intro,
//     native-track preservation, untrusted-content handling (no HTML injection).

let checks = 0;
function ok(condition: boolean, label: string) {
  assert.ok(condition, label);
  checks += 1;
}

// ============================================================
// §1 — VDRK client
// ============================================================

// 1a. file URL validation + rewriting.
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/movie/278/English2.vtt') === '/api/content/subtitles/vtt/movie/278/English2', '1a. movie file URL → same-origin proxy path');
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/tv/1399/1/1/Arabic2.vtt') === '/api/content/subtitles/vtt/tv/1399/1/1/Arabic2', '1a. tv file URL → same-origin proxy path (season/episode preserved)');
ok(vdrkFileToProxyPath('http://cache.vdrk.site/v1/vtt/movie/278/English2.vtt') === null, '1a. plain-http file URL rejected');
ok(vdrkFileToProxyPath('https://evil.example/v1/vtt/movie/278/English2.vtt') === null, '1a. foreign host rejected');
ok(vdrkFileToProxyPath('https://cache.vdrk.site.evil.com/v1/vtt/movie/278/English2.vtt') === null, '1a. suffix-spoofed host rejected');
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/movie/278/English2.vtt?x=1') === null, '1a. query strings rejected');
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/movie/278/../../etc/passwd.vtt') === null, '1a. traversal paths rejected');
ok(vdrkFileToProxyPath('https://cache.vdrk.site/v1/vtt/movie/278/not-a-vtt.txt') === null, '1a. non-.vtt leaf rejected');
ok(vdrkFileToProxyPath('not a url') === null, '1a. malformed URLs rejected');

// 1b. Entry parsing — variants stay individual, junk is dropped, dedupe by URL.
const parsed = parseVdrkEntries([
  { label: 'English', file: 'https://cache.vdrk.site/v1/vtt/movie/278/English.vtt' },
  { label: 'English2', file: 'https://cache.vdrk.site/v1/vtt/movie/278/English2.vtt' },
  { label: 'English3', file: 'https://cache.vdrk.site/v1/vtt/movie/278/English3.vtt' },
  { label: 'Same file again', file: 'https://cache.vdrk.site/v1/vtt/movie/278/English.vtt' },
  { label: '', file: 'https://cache.vdrk.site/v1/vtt/movie/278/Empty.vtt' },
  { file: 'https://cache.vdrk.site/v1/vtt/movie/278/NoLabel.vtt' },
  { label: 'Foreign', file: 'https://evil.example/v1/vtt/movie/278/Foreign.vtt' },
  'not-an-object',
  null,
]);
ok(parsed.length === 3, '1b. only valid, distinct-file entries survive');
ok(parsed.map((track) => track.label).join(',') === 'English,English2,English3', '1b. variants English/English2/English3 stay individually selectable');
ok(parsed.every((track) => track.url.startsWith('/api/content/subtitles/vtt/')), '1b. every surviving track uses the same-origin proxy URL');

// 1c. Merge — native first, external appended, URL dedupe.
const merged = mergeSubtitleTracks(
  [{ url: 'https://native.example/sub.vtt', label: 'Native' }],
  [{ url: '/api/content/subtitles/vtt/movie/278/English', label: 'English' }],
);
ok(merged.length === 2 && (merged[0] as { label: string }).label === 'Native', '1c. native tracks keep priority and order');
ok(mergeSubtitleTracks([{ url: 'https://native.example/x.vtt', label: 'X' }], [{ url: 'https://native.example/x.vtt', label: 'X external dup' }]).length === 1, '1c. identical URLs dedupe (native wins)');
ok(mergeSubtitleTracks(undefined, [{ url: '/p', label: 'E' }]).length === 1, '1c. missing native list merges cleanly');

// 1d. Controller — cache, in-flight dedup, stale keys, failure classes.
function mockListFetch(response: { status?: number; body?: string; contentType?: string; calls?: string[] }) {
  return (async (input: unknown) => {
    response.calls?.push(String(input));
    const body = response.body ?? '[]';
    return {
      ok: (response.status ?? 200) >= 200 && (response.status ?? 200) < 300,
      status: response.status ?? 200,
      statusText: 'OK',
      headers: { get: () => response.contentType ?? 'application/json' },
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  }) as unknown as typeof fetch;
}
{
  const calls: string[] = [];
  const controller = createExternalSubtitleController(mockListFetch({ calls, body: JSON.stringify([{ label: 'English', file: 'https://cache.vdrk.site/v1/vtt/movie/278/English.vtt' }]) }));
  const first = await controller.load({ kind: 'movie', tmdbId: 278 }, 'movie:278');
  ok(first.tracks.length === 1 && first.error === null && !first.superseded, '1d. a valid list loads through the controller');
  ok(calls.length === 1 && calls[0] === `${VDRK_LIST_ORIGIN}/v1/movie/278`, '1d. the list URL is the verified API shape (browser-direct, CORS-open origin)');
  const second = await controller.load({ kind: 'movie', tmdbId: 278 }, 'movie:278');
  ok(second.tracks.length === 1 && calls.length === 1, '1d. the second load is served from the bounded TTL cache (no second fetch)');
  controller.clearForTests();
}
{
  const controller = createExternalSubtitleController(mockListFetch({ body: '[]' }));
  const result = await controller.load({ kind: 'movie', tmdbId: 999999999 }, 'movie:999999999');
  ok(result.tracks.length === 0 && result.error === null, '1d. an EMPTY list is a valid response (verified upstream shape for unknown ids)');
  controller.clearForTests();
}
{
  const controller = createExternalSubtitleController(mockListFetch({ status: 503, body: 'nope' }));
  const result = await controller.load({ kind: 'movie', tmdbId: 278 }, 'movie:278');
  ok(result.tracks.length === 0 && result.error === 'network', '1d. an HTTP failure degrades to an empty track list (playback never blocked)');
  controller.clearForTests();
}
{
  const controller = createExternalSubtitleController(mockListFetch({ body: '<html>not json</html>' }));
  const result = await controller.load({ kind: 'movie', tmdbId: 278 }, 'movie:278');
  ok(result.error === 'invalid-response', '1d. non-JSON bodies classify as invalid-response');
  controller.clearForTests();
}
{
  const controller = createExternalSubtitleController(mockListFetch({ body: '[]' }));
  const stale = await controller.load({ kind: 'movie', tmdbId: 278 }, 'movie:999');
  ok(stale.superseded === true && stale.tracks.length === 0, '1d. a result for a SUPERSEDED media key resolves empty (stale-response guard)');
  controller.clearForTests();
}
{
  // In-flight dedup: two concurrent loads for the same key → ONE fetch.
  const calls: string[] = [];
  const controller = createExternalSubtitleController(mockListFetch({ calls, body: '[]' }));
  await Promise.all([controller.load({ kind: 'movie', tmdbId: 278 }, 'movie:278'), controller.load({ kind: 'movie', tmdbId: 278 }, 'movie:278')]);
  ok(calls.length === 1, '1d. concurrent loads for one media key dedupe into a single fetch');
  controller.clearForTests();
}
{
  // TV request shape + key identity + invalid requests.
  const calls: string[] = [];
  const controller = createExternalSubtitleController(mockListFetch({ calls, body: '[]' }));
  await controller.load({ kind: 'tv', tmdbId: 1399, season: 1, episode: 1 }, 'tv:1399:1:1');
  ok(calls[0] === `${VDRK_LIST_ORIGIN}/v1/tv/1399/1/1`, '1d. TV lists use the tmdb/season/episode API shape');
  ok(externalSubtitlesKey({ kind: 'tv', tmdbId: 1399, season: 1, episode: 1 }) === 'tv:1399:1:1', '1d. media keys distinguish episodes');
  controller.clearForTests();
}

// ============================================================
// §2 — VDRK server module (same-origin proxy backend)
// ============================================================

// 2a. Segment validation.
ok(validateTmdbIdParam('278') === 278 && validateTmdbIdParam('0') === null && validateTmdbIdParam('0278') === null && validateTmdbIdParam('-1') === null && validateTmdbIdParam('abc') === null && validateTmdbIdParam('1'.repeat(17)) === null, '2a. tmdb ids: canonical positive integers only');
ok(validatePositiveIntParam('1') === 1 && validatePositiveIntParam('0') === null && validatePositiveIntParam('-3') === null && validatePositiveIntParam('2.5') === null, '2a. season/episode: positive integers only (no silent episode fallback)');
ok(validateLabelParam('English2') === 'English2' && validateLabelParam('Brazilian4') === 'Brazilian4', '2a. observed label shapes accepted');
ok(validateLabelParam('../etc') === null && validateLabelParam('a%2Fb') === null && validateLabelParam('') === null && validateLabelParam('x'.repeat(65)) === null, '2a. traversal/encoded/empty/oversized labels rejected');

// 2b. Upstream URL is REBUILT from validated parts (no client URL accepted).
ok(buildUpstreamVttUrl('movie', 278, 'English2') === `${VDRK_VTT_ORIGIN}/v1/vtt/movie/278/English2.vtt`, '2b. movie upstream URL shape');
ok(buildUpstreamVttUrl('tv', 1399, 'Arabic2', 1, 1) === `${VDRK_VTT_ORIGIN}/v1/vtt/tv/1399/1/1/Arabic2.vtt`, '2b. tv upstream URL shape');

// 2c. Bounded upstream fetch — content-type, size cap, upstream failure.
function mockVttFetch(response: { status?: number; body?: string; contentType?: string; headers?: Record<string, string> }) {
  return (async () => ({
    ok: (response.status ?? 200) >= 200 && (response.status ?? 200) < 300,
    status: response.status ?? 200,
    headers: new Headers({ 'content-type': response.contentType ?? 'text/vtt; charset=utf-8', ...(response.headers ?? {}) }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(response.body ?? 'WEBVTT'));
        controller.close();
      },
    }),
  })) as unknown as typeof fetch;
}
{
  clearVttCacheForTests();
  const original = globalThis.fetch;
  globalThis.fetch = mockVttFetch({ body: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHi' });
  try {
    const result = await fetchUpstreamVttText(buildUpstreamVttUrl('movie', 278, 'English2'));
    ok(result.ok && result.text.startsWith('WEBVTT') && !result.fromCache, '2c. a text/vtt upstream passes through');
    const cached = await fetchUpstreamVttText(buildUpstreamVttUrl('movie', 278, 'English2'));
    ok(cached.ok && cached.fromCache, '2c. the in-process TTL cache serves repeats (bounded upstream load)');
  } finally {
    globalThis.fetch = original;
  }
  clearVttCacheForTests();
}
{
  clearVttCacheForTests();
  const bad = await (async () => {
    const fetchVtt = mockVttFetch({ contentType: 'text/html' });
    const original = globalThis.fetch;
    globalThis.fetch = fetchVtt;
    try { return await fetchUpstreamVttText(buildUpstreamVttUrl('movie', 278, 'Wrong')); } finally { globalThis.fetch = original; }
  })();
  ok(!bad.ok && bad.status === 502, '2c. a non-text/vtt upstream is a 502 (image/HTML never passes through)');
}
{
  clearVttCacheForTests();
  const bad = await (async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mockVttFetch({ status: 404, body: 'nope', contentType: 'text/vtt' });
    try { return await fetchUpstreamVttText(buildUpstreamVttUrl('movie', 278, 'Missing')); } finally { globalThis.fetch = original; }
  })();
  ok(!bad.ok && bad.status === 502, '2c. upstream 404 → 502 (honest unavailability)');
}
{
  clearVttCacheForTests();
  const big = await (async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mockVttFetch({ body: 'WEBVTT', contentType: 'text/vtt', headers: { 'content-length': String(3_000_000) } });
    try { return await fetchUpstreamVttText(buildUpstreamVttUrl('movie', 278, 'Huge')); } finally { globalThis.fetch = original; }
  })();
  ok(!big.ok && big.status === 502, '2c. oversized declared content is rejected (bounded response sizes)');
}
{
  clearVttCacheForTests();
  const streamed = await (async () => {
    const original = globalThis.fetch;
    // No content-length — the streamed read must still cap the body.
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/vtt' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('x'.repeat(2_100_000)));
          controller.close();
        },
      }),
    })) as unknown as typeof fetch;
    try { return await fetchUpstreamVttText(buildUpstreamVttUrl('movie', 278, 'Streamed')); } finally { globalThis.fetch = original; }
  })();
  ok(!streamed.ok && streamed.status === 502, '2c. the streamed read caps bodies even without content-length');
}

// 2d. Route files exist and follow the security contract.
const movieRoute = readFileSync(resolve('src/routes/api/content/subtitles/vtt/movie/[tmdbId]/[label]/+server.ts'), 'utf-8');
const tvRoute = readFileSync(resolve('src/routes/api/content/subtitles/vtt/tv/[tmdbId]/[season]/[episode]/[label]/+server.ts'), 'utf-8');
ok(/validateTmdbIdParam\(params\.tmdbId/.test(movieRoute) && /validateLabelParam\(params\.label/.test(movieRoute), '2d. the movie route validates every path segment');
ok(/buildUpstreamVttUrl\('movie', tmdbId, label\)/.test(movieRoute), '2d. the movie route rebuilds the upstream URL from validated parts');
ok(/validatePositiveIntParam\(params\.season/.test(tvRoute) && /validatePositiveIntParam\(params\.episode/.test(tvRoute), '2d. the tv route validates season/episode as positive integers');
ok(/buildUpstreamVttUrl\('tv', tmdbId, label, season, episode\)/.test(tvRoute), '2d. the tv route rebuilds the upstream URL from validated parts');
ok(movieRoute.includes("'text/vtt; charset=utf-8'") && tvRoute.includes("'text/vtt; charset=utf-8'"), '2d. both routes serve text/vtt (track-compatible content type)');
ok(!movieRoute.includes('url.searchParams') && !tvRoute.includes('url.searchParams'), '2d. NEITHER route accepts a client-supplied URL (no generic proxy)');
ok(/Invalid subtitle request/.test(movieRoute) && /Invalid subtitle request/.test(tvRoute), '2d. invalid segments fail closed with 400');

// ============================================================
// §3 — TheIntroDB (Skip Intro)
// ============================================================

// 3a. Validation truth table (ms from the API → seconds at the boundary).
const segments: NormalizedSegmentTimestamp[] = [
  { startMs: 0, endMs: 90_000, durationMs: 90_000, startsAtBeginning: true, endsAtMediaEnd: false },
  { startMs: 120_000, endMs: 200_000, durationMs: 80_000, startsAtBeginning: false, endsAtMediaEnd: false },
];
{
  const valid = validateIntroSegments(segments, 3600);
  ok(valid.length === 2, '3a. MULTIPLE intro segments are preserved (no single-segment assumption)');
  ok(valid[0].startSec === 0 && valid[0].endSec === 90, '3a. milliseconds convert to seconds at the player boundary');
  ok(validateIntroSegments([{ startMs: 0, endMs: null, durationMs: null, startsAtBeginning: false, endsAtMediaEnd: true }], 3600).length === 0, '3a. a null end (no seek target) is discarded, never guessed');
  ok(validateIntroSegments([{ startMs: 200_000, endMs: 100_000, durationMs: null, startsAtBeginning: false, endsAtMediaEnd: false }], 3600).length === 0, '3a. reversed ranges are rejected');
  ok(validateIntroSegments([{ startMs: -5_000, endMs: 10_000, durationMs: null, startsAtBeginning: false, endsAtMediaEnd: false }], 3600).length === 0, '3a. negative starts are rejected');
  ok(validateIntroSegments([{ startMs: Number.NaN, endMs: 10_000, durationMs: null, startsAtBeginning: false, endsAtMediaEnd: false }], 3600).length === 0, '3a. non-finite values are rejected');
  ok(validateIntroSegments([{ startMs: 3_700_000, endMs: 3_800_000, durationMs: null, startsAtBeginning: false, endsAtMediaEnd: false }], 3600).length === 0, '3a. ranges starting beyond the actual duration are rejected');
  ok(validateIntroSegments([{ startMs: 0, endMs: 3_700_000, durationMs: null, startsAtBeginning: true, endsAtMediaEnd: false }], 3600).length === 0, '3a. ranges ending clearly beyond the actual duration (+5s tolerance) are rejected');
  ok(validateIntroSegments([{ startMs: 0, endMs: 3_603_000, durationMs: null, startsAtBeginning: true, endsAtMediaEnd: false }], 3600).length === 1, '3a. the +5s tolerance keeps near-boundary ends');
  ok(validateIntroSegments(segments, null).length === 2, '3a. without a known duration, structurally valid ranges pass (duration validation deferred)');
  ok(validateIntroSegments(undefined, 3600).length === 0 && validateIntroSegments([], 3600).length === 0, '3a. missing/empty intro data → no segments');
}

// 3b. Controller — raw API response → validated segments; negative backoff; stale keys.
// Mock bodies play the v4 SERVER: the raw shape is `{ tvdb_id, type, intro: [{ start_ms, end_ms }] }`
// (v4 keys responses by the resolved TVDB identity and omits tmdb_id entirely — OpenAPI v4.0.0;
// tvdb_id values are fixtures, nothing asserts them). The client is addressed with tmdbId.
type CapturedCall = { url: string };
function mockIntroFetch(raw: unknown, opts?: { status?: number; calls?: CapturedCall[] }) {
  return (async (input: unknown) => {
    opts?.calls?.push({ url: String(input) });
    const status = opts?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(raw),
    };
  }) as unknown as typeof fetch;
}
{
  const calls: CapturedCall[] = [];
  const lookup = createIntroLookup(mockIntroFetch({ tvdb_id: 121361, type: 'tv', season: 1, episode: 1, intro: [{ start_ms: null, end_ms: 90_000 }] }, { calls }));
  const result = await lookup.getIntroSegments({ kind: 'tv', tmdbId: 1399, season: 1, episode: 1, durationSec: 3600 }, 'tv:1399:1:1');
  ok(result.segments.length === 1 && result.segments[0].startSec === 0 && result.segments[0].endSec === 90, '3b. a null API start normalizes to the beginning (package contract) and validates');
  ok(calls[0]?.url.includes('api.theintrodb.org/v4/media'), '3b. the lookup hits the v4 endpoint (/v4) — the package default base URL, never a pinned older version');
  ok(calls[0]?.url.includes('tmdb_id=1399') && calls[0]?.url.includes('season=1') && calls[0]?.url.includes('episode=1'), '3b. the lookup still addresses by the TMDB id + actual season/episode (v4 resolves tmdb_id server-side, incl. TMDB episode numbering)');
  ok(calls[0]?.url.includes('duration_ms=3600000'), '3b. the ACTUAL playback duration is forwarded as durationMs (never the catalog runtime)');
  const second = await lookup.getIntroSegments({ kind: 'tv', tmdbId: 1399, season: 1, episode: 1, durationSec: 3600 }, 'tv:1399:1:1');
  ok(second.segments.length === 1 && calls.length === 1, '3b. the cached lookup does not re-fetch');
  lookup.clearForTests();
}
{
  const calls: CapturedCall[] = [];
  const lookup = createIntroLookup(mockIntroFetch({ tvdb_id: 121361, type: 'tv', intro: [] }, { calls }));
  await lookup.getIntroSegments({ kind: 'tv', tmdbId: 1399, season: 2, episode: 3 }, 'tv:1399:2:3');
  await lookup.getIntroSegments({ kind: 'tv', tmdbId: 1399, season: 2, episode: 3 }, 'tv:1399:2:3');
  ok(calls.length === 1, '3b. missing data backs off — repeated lookups do not hammer the API');
  lookup.clearForTests();
}
{
  const lookup = createIntroLookup(mockIntroFetch({ error: 'Failed to retrieve submissions' }, { status: 500 }));
  const failed = await lookup.getIntroSegments({ kind: 'movie', tmdbId: 278, durationSec: 7200 }, 'movie:278');
  ok(failed.segments.length === 0 && failed.empty, '3b. an API failure degrades to no skip button (strictly optional feature)');
  const backed = await lookup.getIntroSegments({ kind: 'movie', tmdbId: 278, durationSec: 7200 }, 'movie:278');
  ok(backed.segments.length === 0, '3b. the failure enters the bounded negative backoff');
  lookup.clearForTests();
}
{
  const lookup = createIntroLookup(mockIntroFetch({ tvdb_id: 77111, type: 'movie', intro: [{ start_ms: 0, end_ms: 120_000 }] }));
  const stale = await lookup.getIntroSegments({ kind: 'movie', tmdbId: 278 }, 'movie:999');
  ok(stale.superseded === true && stale.segments.length === 0, '3b. a stale media key never drives the UI');
  lookup.clearForTests();
}
{
  // v4 response union: with no submissions the API can answer 200 with the
  // per-episode `episodes` fallback instead of a media record. That shape is
  // verified emptiness — no segments, and NOT a typed failure.
  // Body mirrors the OpenAPI v4.0.0 "episode-list" example exactly (every
  // per-segment count field is required by the API's schema).
  const lookup = createIntroLookup(mockIntroFetch({
    tvdb_id: 71663,
    type: 'tv',
    episodes: [{
      season: 1, episode: 1, total_submission_count: 4, total_accepted_count: 4, total_pending_count: 0, total_rejected_count: 0, flag_votes: 0,
      intro_accepted_count: 4, intro_pending_count: 0, intro_rejected_count: 0,
      recap_accepted_count: 0, recap_pending_count: 0, recap_rejected_count: 0,
      credits_accepted_count: 0, credits_pending_count: 0, credits_rejected_count: 0,
      preview_accepted_count: 0, preview_pending_count: 0, preview_rejected_count: 0,
    }],
  }));
  const fallback = await lookup.getIntroSegments({ kind: 'tv', tmdbId: 71663, season: 1, episode: 1, durationSec: 1800 }, 'tv:71663:1:1');
  ok(fallback.segments.length === 0 && fallback.empty && fallback.errorKind === null, '3b. the v4 episode-list fallback (kind episodes, 200) is verified emptiness — no segments, no typed error');
  lookup.clearForTests();
}

// ============================================================
// §4 — Shell + architecture contracts
// ============================================================

const shell = readFileSync(resolve('src/lib/components/player/PlayerShell.svelte'), 'utf-8');
const watchPage = readFileSync(resolve('src/routes/watch/[type]/[id]/+page.svelte'), 'utf-8');

// 4a. Media-scoped lookups (source switches keep tracks; episodes reload).
ok(/mediaLookupKey = `\$\{content\.type\}:\$\{content\.id\}:\$\{currentEpisode\?\.season.*:\$\{currentEpisode\?\.episode/.test(shell), '4a. the lookup key is the MEDIA identity (type + id + season/episode)');
ok(/\$: if \(browser && mediaLookupKey !== externalSubtitlesKey\) \{[\s\S]*?externalSubtitles = \[\];/.test(shell), '4a. episode/media changes reset the external list before reloading');
ok(/\$: if \(browser && duration > 0 && mediaLookupKey !== introKey\) \{/.test(shell), '4a. the intro lookup waits for a trustworthy ACTUAL duration (never the catalog runtime)');
ok(/const durationSec = duration > 0 \? duration : null;/.test(shell), '4a. durationSec comes from the media element duration only');
// 4b. Playhead-gated Skip Intro + existing seek pipeline.
ok(/activeSkipSegment = introSegments\.find\(\(segment\) => currentTime >= segment\.startSec && currentTime < segment\.endSec - 0\.25\)/.test(shell), '4b. the button targets the VERIFIED segment containing the playhead');
ok(/seek\(activeSkipSegment\.endSec\)/.test(shell), '4b. clicking seeks to the segment end through the EXISTING shell seek (resume/progress preserved)');
// 4c. Subtitle selection cleanup + native preservation.
ok(/mergedSubtitles = mergeSubtitleTracks\(effectiveSubtitles, externalSubtitles\)/.test(shell), '4c. native tracks lead the merged menu (stream-provided functionality preserved)');
ok(/!mergedSubtitles\.some\(\(track\) => track\.url === selectedSubtitle\)[\s\S]*?selectedSubtitle = '';/.test(shell), '4c. stale selections are cleared when the merged list changes');
// CONTRACT CHANGE (focused fixes, Issue 1): TextTrack MODE ownership moved
// from the shell's setSubtitle into PlayerViewport (syncSubtitleTrackModes):
// the selected track runs 'hidden' while the custom overlay paints (the
// offset/appearance requirements), 'showing' while the OS paints (PiP /
// native video fullscreen), everything else 'disabled' — exactly the old
// disable-others contract, now with one authoritative writer.
ok(/function setSubtitle\(url: string\) \{[\s\S]*?selectedSubtitle = url;\n  \}/.test(shell), '4c. the shell’s setSubtitle is URL-state only (single source of truth for selection)');
const viewportSource = readFileSync(resolve('src/lib/components/player/PlayerViewport.svelte'), 'utf-8');
ok(/function syncSubtitleTrackModes\(\)[\s\S]*?'disabled'/.test(viewportSource), '4c. track switching disables unselected tracks through the native engine APIs (viewport-owned)');
ok(/subtitleOverlaySuppressed \? 'showing' : 'hidden'/.test(viewportSource), '4c. the selected track runs hidden (overlay paints) or showing (OS paints) — native engine APIs');
// 4d. Untrusted content handling — no VTT text as HTML anywhere.
ok(!/innerHTML/.test(shell), '4d. the shell never injects subtitle content as HTML (native <track> APIs only)');
ok(/<track kind="captions"/.test(readFileSync(resolve('src/lib/components/player/PlayerViewport.svelte'), 'utf-8')), '4d. external VTT rides the native <track> mechanism');
// 4e. The list is fetched browser-direct (CORS verified open); only VTT goes through the proxy.
ok(/from '\$lib\/client\/player\/subtitles\/external-subtitles'/.test(shell), '4e. the shell uses the validated external-subtitle controller');
ok(!/sub\.vdrk\.site/.test(shell) && !/cache\.vdrk\.site/.test(shell), '4e. the shell never hardcodes third-party origins (constants live in the modules)');

console.log(`player_ui_v2_phase3_test: ${checks} checks passed`);
