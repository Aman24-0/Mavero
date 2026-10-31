/**
 * VidCore Multi Stream — multi-server extraction verification (round 32).
 *
 * NO real network: `globalThis.fetch` is stubbed with canned per-provider
 * payloads mirroring BOTH documented response shapes:
 *
 *   sources: [ { url, server: "Supreme", type: "hls" }, … ]   (CoorenLabs contract)
 *   streams: [ { url, name: "720p", type: "hls" }, … ]        (legacy shape)
 *
 * Covered:
 *   §1  token + API URL construction (pure).
 *   §2  ALL providers are queried; one source per valid HLS URL; server
 *       names ride the `server` field; provider-priority order holds.
 *   §3  `sources` entries win the server display name ("Supreme") and the
 *       legacy `streams` shape falls back to the provider display name.
 *   §4  non-HLS entries (mp4/dash) are dropped, never coerced.
 *   §5  the same URL returned by two providers is deduped.
 *   §6  dead/empty providers are tolerated (aggregation continues).
 *   §7  zero valid streams across ALL providers → NO_SOURCES.
 *   §8  hard bound: aggregation never exceeds 12 servers.
 *
 * Usage:
 *   pnpm exec tsx --tsconfig ./tsconfig.test.json scripts/vidcore_multi_server_test.ts
 */

import assert from 'node:assert/strict';

let passed = 0;
function ok(condition: unknown, label: string, hint?: string) {
  assert.ok(condition, hint ? `${label} (${hint})` : label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

import {
  generateVidCoreToken,
  buildVidCoreApiUrl,
  scrapeVidCore
} from '../src/lib/server/vod/vidcore-scraper';
import { ScraperError } from '../src/lib/server/vod/vidsrc-scraper';

// ---------------------------------------------------------------------------
// fetch stub — canned per-provider payloads keyed by the provider query param.
// ---------------------------------------------------------------------------

const REAL_FETCH = globalThis.fetch;
const PROVIDERS = ['mb-earth', 'mb-mars', 'mb-jupiter', 'mb-saturn', 'mb-andromeda', 'mb-nebula'];

type Payload = Record<string, unknown>;
let providerPayloads: Record<string, Payload> = {};
let queriedProviders: string[] = [];

function stubFetch() {
  queriedProviders = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const provider = /provider=([^&]+)/.exec(url)?.[1] ?? '';
    queriedProviders.push(provider);
    const body = JSON.stringify(providerPayloads[provider] ?? { streams: [], subtitles: [] });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = REAL_FETCH;
}

// ============================================================
// §1 — token + API URL construction (pure).
// ============================================================
{
  const token = generateVidCoreToken('27205', 'movie');
  ok(token.endsWith('.own'), '§1 the token carries the .own suffix');
  const decoded = JSON.parse(Buffer.from(token.replace(/\.own$/, ''), 'base64').toString('utf-8')) as Record<string, unknown>;
  ok(decoded.tmdbId === 27205 && decoded.type === 'movie', '§1 the token decodes to the tmdb payload');
  const tvToken = generateVidCoreToken('1399', 'tv', 2, 5);
  const tvDecoded = JSON.parse(Buffer.from(tvToken.replace(/\.own$/, ''), 'base64').toString('utf-8')) as Record<string, unknown>;
  ok(tvDecoded.season === 2 && tvDecoded.episode === 5, '§1 TV tokens carry season + episode');

  const apiUrl = buildVidCoreApiUrl('27205', 'movie', 'mb-earth');
  ok(apiUrl.startsWith('https://vidcore.org/api/source/movie/27205?'), '§1 the movie API URL targets /api/source/movie/{id}');
  ok(/provider=mb-earth/.test(apiUrl), '§1 the API URL carries the provider');
  const tvUrl = buildVidCoreApiUrl('1399', 'tv', 'mb-mars', 2, 5);
  ok(tvUrl.startsWith('https://vidcore.org/api/source/tv/1399?'), '§1 the TV API URL targets /api/source/tv/{id}');
  ok('§1 token + URL construction verified');
}

// ============================================================
// §2 — ALL providers queried, one source per valid HLS URL, ordered.
// ============================================================
{
  stubFetch();
  providerPayloads = {
    'mb-earth': { sources: [{ url: 'https://cdn-a.example.com/supreme/master.m3u8', server: 'Supreme', type: 'hls' }], streams: [], subtitles: [] },
    'mb-jupiter': { streams: [{ url: 'https://cdn-b.example.com/720/index.m3u8', name: '720p', type: 'hls' }], subtitles: [] },
    'mb-andromeda': { streams: [{ url: 'https://cdn-c.example.com/play/master.m3u8', name: '1080p HD', type: 'hls' }], subtitles: [] }
  };
  try {
    const result = await scrapeVidCore('27205', 'movie', undefined, undefined);
    ok(PROVIDERS.every((provider) => queriedProviders.includes(provider)), '§2 EVERY configured provider was queried');
    ok(result.sources.length === 3, '§2 one source per valid HLS URL (3 servers aggregated)');
    ok(result.sources.every((source) => typeof source.server === 'string' && source.server.length > 0), '§2 every source carries a server name');
    ok(result.sources[0]!.server === 'Supreme' && result.sources[0]!.url.includes('cdn-a'), '§2 the first source is the highest-priority provider (earth → Supreme)');
    ok(result.sources[1]!.server === 'Jupiter' && result.sources[2]!.server === 'Andromeda', '§2 legacy `streams` entries fall back to the provider display name');
    ok(result.provider === 'vidcore' && result.referer === 'https://vidcore.org/', '§2 the result keeps the vidcore provider + referer contract');
    ok(result.sources.every((source) => source.kind === 'direct'), '§2 every source is a direct HLS source');
  } finally {
    restoreFetch();
  }
}

// ============================================================
// §3 — the CoorenLabs `sources` shape: server names verbatim.
// ============================================================
{
  stubFetch();
  providerPayloads = {
    'mb-mars': {
      sources: [
        { url: 'https://cdn-x.example.com/prime/master.m3u8', server: 'Prime', type: 'hls' },
        { url: 'https://cdn-y.example.com/horizon/master.m3u8', server: 'Horizon', type: 'hls' }
      ],
      streams: [],
      subtitles: []
    }
  };
  try {
    const result = await scrapeVidCore('155', 'movie', undefined, undefined);
    ok(result.sources.length === 2, '§3 both `sources` entries are returned');
    ok(result.sources[0]!.server === 'Prime' && result.sources[1]!.server === 'Horizon', '§3 server names come from the API verbatim (Prime, Horizon)');
    ok('§3 CoorenLabs sources shape verified');
  } finally {
    restoreFetch();
  }
}

// ============================================================
// §4 — non-HLS entries are dropped, never coerced.
// ============================================================
{
  stubFetch();
  providerPayloads = {
    'mb-earth': {
      streams: [
        { url: 'https://cdn-a.example.com/file.mp4', name: 'MP4', type: 'mp4' },
        { url: 'https://cdn-a.example.com/dash/manifest.mpd', name: 'DASH', type: 'dash' },
        { url: 'https://cdn-a.example.com/hls/master.m3u8', name: 'HLS', type: 'hls' }
      ],
      subtitles: []
    }
  };
  try {
    const result = await scrapeVidCore('603', 'movie', undefined, undefined);
    ok(result.sources.length === 1, '§4 exactly one (the HLS) source survives');
    ok(result.sources[0]!.url.endsWith('.m3u8'), '§4 the surviving source is the HLS manifest');
  } finally {
    restoreFetch();
  }
}

// ============================================================
// §5 — duplicate URLs across providers are deduped.
// ============================================================
{
  stubFetch();
  providerPayloads = {
    'mb-earth': { streams: [{ url: 'https://shared.example.com/master.m3u8', type: 'hls' }], subtitles: [] },
    'mb-jupiter': { streams: [{ url: 'https://shared.example.com/master.m3u8', name: '720p', type: 'hls' }], subtitles: [] }
  };
  try {
    const result = await scrapeVidCore('76341', 'movie', undefined, undefined);
    ok(result.sources.length === 1, '§5 the shared URL appears exactly once');
    ok(result.sources[0]!.server === 'Earth', '§5 the higher-priority provider wins the dedupe');
  } finally {
    restoreFetch();
  }
}

// ============================================================
// §6 — dead/empty providers are tolerated.
// ============================================================
{
  stubFetch();
  providerPayloads = {
    'mb-earth': { streams: [], subtitles: [] },
    'mb-saturn': { streams: [{ url: 'https://cdn-s.example.com/master.m3u8', type: 'hls' }], subtitles: [] }
  };
  try {
    const result = await scrapeVidCore('447365', 'movie', undefined, undefined);
    ok(result.sources.length === 1 && result.sources[0]!.server === 'Saturn', '§6 a single live server is enough (empty providers skipped)');
  } finally {
    restoreFetch();
  }

  // A provider whose fetch REJECTS (network error) is tolerated too. The
  // stub gives every OTHER provider a live stream — the rejecting saturn
  // must simply contribute nothing while the rest still aggregate.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('provider=mb-saturn')) throw new Error('boom');
    return new Response(JSON.stringify({ streams: [{ url: `https://cdn-t.example.com/${/provider=([^&]+)/.exec(url)?.[1]}/master.m3u8`, type: 'hls' }], subtitles: [] }), { status: 200 }) as Response;
  }) as typeof fetch;
  try {
    const result = await scrapeVidCore('299534', 'movie', undefined, undefined);
    ok(result.sources.length === PROVIDERS.length - 1, '§6 a rejecting provider never breaks the aggregation (the rest still resolve)');
    ok(result.sources.every((source) => source.server !== 'Saturn'), '§6 the rejecting provider contributes no server');
  } finally {
    restoreFetch();
  }
}

// ============================================================
// §7 — zero valid streams across ALL providers → NO_SOURCES.
// ============================================================
{
  stubFetch();
  providerPayloads = {};
  try {
    await scrapeVidCore('155', 'movie', undefined, undefined);
    ok(false, '§7 the all-empty scrape must throw');
  } catch (error) {
    ok(error instanceof ScraperError && error.code === 'NO_SOURCES', '§7 the all-empty scrape throws NO_SOURCES');
  } finally {
    restoreFetch();
  }
}

// ============================================================
// §8 — hard bound: never more than 12 aggregated servers.
// ============================================================
{
  stubFetch();
  const many: Payload[] = [];
  for (let index = 0; index < 30; index++) {
    many.push({ url: `https://cdn-many.example.com/${index}/master.m3u8`, server: `Server ${index}`, type: 'hls' });
  }
  providerPayloads = { 'mb-earth': { sources: many, streams: [], subtitles: [] } };
  try {
    const result = await scrapeVidCore('603', 'movie', undefined, undefined);
    ok(result.sources.length === 12, '§8 the aggregation is bounded at 12 servers');
  } finally {
    restoreFetch();
  }
}

console.log(`\nvidcore_multi_server_test: ${passed} checks passed`);
