/**
 * VidCore Multi Stream — multi-server extraction verification (round 33).
 *
 * NO real network: `globalThis.fetch` is stubbed with canned per-provider
 * payloads mirroring BOTH documented response shapes:
 *
 *   sources: [ { url, server: "Tethys", type: "hls" }, … ]   (server-addressed)
 *   streams: [ { url, name: "720p", type: "hls" }, … ]       (legacy shape)
 *
 * 2026-10 round 33 — THE CELESTIAL ROSTER: VidCore's servers are named after
 * planets and moons (NOT "Supreme"/"Prime"), there are ~28 of them, and the
 * AUDIO LANGUAGE is bound to the server (Enceladus + Hyperion = Hindi,
 * Callisto = Telugu, the rest = English). The scraper queries the FULL
 * roster, parses the language (API-attached or verified roster), and returns
 * one source per server carrying `server` + `language`.
 *
 * Covered:
 *   §1  token + API URL construction (pure).
 *   §2  ALL roster providers are queried; one source per valid HLS URL;
 *       server names ride the `server` field; provider-priority order holds.
 *   §3  the `sources` shape: server names verbatim + attached-language
 *       parsing ("Enceladus (Hindi)" → name "Enceladus", language "Hindi").
 *   §4  non-HLS entries (mp4/dash) are dropped, never coerced.
 *   §5  the same URL returned by two providers is deduped.
 *   §6  dead/empty providers are tolerated (aggregation continues).
 *   §7  zero valid streams across ALL providers → NO_SOURCES.
 *   §8  hard bound: aggregation never exceeds 28 servers.
 *   §9  LANGUAGE resolution: explicit `language` field → "(Hindi)" attached
 *       form → verified roster fallback (Tethys = English, mb-hyperion =
 *       Hindi) → unknown stays language-less (never invented).
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
// The FULL verified celestial roster — must mirror the scraper's provider
// list exactly (planets first, then moons; Enceladus/Hyperion/Callisto carry
// their non-English languages).
const PROVIDERS = [
  'mb-earth', 'mb-mars', 'mb-jupiter', 'mb-neptune', 'mb-saturn', 'mb-venus', 'mb-mercury', 'mb-uranus',
  'mb-titan', 'mb-europa', 'mb-ganymede', 'mb-io', 'mb-triton', 'mb-charon', 'mb-phobos', 'mb-deimos',
  'mb-oberon', 'mb-titania', 'mb-umbriel', 'mb-ariel', 'mb-rhea', 'mb-iapetus', 'mb-dione', 'mb-tethys',
  'mb-enceladus', 'mb-callisto', 'mb-hyperion', 'mb-mimas'
];

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
  ok(true, '§1 token + URL construction verified');
}

// ============================================================
// §2 — ALL roster providers queried, one source per valid HLS URL, ordered.
// ============================================================
{
  stubFetch();
  providerPayloads = {
    'mb-earth': { sources: [{ url: 'https://cdn-a.example.com/earth/master.m3u8', server: 'Earth', type: 'hls' }], streams: [], subtitles: [] },
    'mb-jupiter': { streams: [{ url: 'https://cdn-b.example.com/720/index.m3u8', name: '720p', type: 'hls' }], subtitles: [] },
    'mb-tethys': { streams: [{ url: 'https://cdn-c.example.com/play/master.m3u8', name: '1080p HD', type: 'hls' }], subtitles: [] }
  };
  try {
    const result = await scrapeVidCore('27205', 'movie', undefined, undefined);
    ok(PROVIDERS.every((provider) => queriedProviders.includes(provider)), '§2 EVERY roster provider was queried (all 28)');
    ok(queriedProviders.length === PROVIDERS.length, '§2 no provider skipped, none queried twice');
    ok(result.sources.length === 3, '§2 one source per valid HLS URL (3 servers aggregated)');
    ok(result.sources.every((source) => typeof source.server === 'string' && source.server.length > 0), '§2 every source carries a server name');
    ok(result.sources[0]!.server === 'Earth' && result.sources[0]!.url.includes('cdn-a'), '§2 the first source is the highest-priority provider (earth)');
    ok(result.sources[1]!.server === 'Jupiter' && result.sources[2]!.server === 'Tethys', '§2 legacy `streams` entries fall back to the roster display name');
    ok(result.provider === 'vidcore' && result.referer === 'https://vidcore.org/', '§2 the result keeps the vidcore provider + referer contract');
    ok(result.sources.every((source) => source.kind === 'direct'), '§2 every source is a direct HLS source');
  } finally {
    restoreFetch();
  }
}

// ============================================================
// §3 — the server-addressed shape: names verbatim + attached language.
// ============================================================
{
  stubFetch();
  providerPayloads = {
    'mb-mars': {
      sources: [
        { url: 'https://cdn-x.example.com/tethys/master.m3u8', server: 'Tethys', type: 'hls' },
        { url: 'https://cdn-y.example.com/enceladus/master.m3u8', server: 'Enceladus (Hindi)', type: 'hls' },
        { url: 'https://cdn-z.example.com/hyperion/master.m3u8', server: 'Hyperion (Hindi)', type: 'hls' }
      ],
      streams: [],
      subtitles: []
    }
  };
  try {
    const result = await scrapeVidCore('155', 'movie', undefined, undefined);
    ok(result.sources.length === 3, '§3 all three `sources` entries are returned');
    ok(result.sources[0]!.server === 'Tethys' && result.sources[1]!.server === 'Enceladus' && result.sources[2]!.server === 'Hyperion', '§3 server names are verbatim MINUS the language parenthetical');
    ok(result.sources[0]!.language === 'English' && result.sources[1]!.language === 'Hindi' && result.sources[2]!.language === 'Hindi', '§3 the attached "(Hindi)" parenthetical becomes the language; Tethys falls back to the verified roster');
    ok(true, '§3 server + language parsing verified');
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
    ok(result.sources[0]!.language === 'English', '§6 a roster server without any language hint gets its verified roster language');
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
// §8 — hard bound: never more than 28 aggregated servers.
// ============================================================
{
  stubFetch();
  const many: Payload[] = [];
  for (let index = 0; index < 40; index++) {
    many.push({ url: `https://cdn-many.example.com/${index}/master.m3u8`, server: `Server ${index}`, type: 'hls' });
  }
  providerPayloads = { 'mb-earth': { sources: many, streams: [], subtitles: [] } };
  try {
    const result = await scrapeVidCore('603', 'movie', undefined, undefined);
    ok(result.sources.length === 28, '§8 the aggregation is bounded at 28 servers (the full roster fits)');
    ok(true, '§8 bound verified');
  } finally {
    restoreFetch();
  }
}

// ============================================================
// §9 — LANGUAGE resolution ladder (round 33).
// ============================================================
{
  stubFetch();
  providerPayloads = {
    // a) explicit `language` field on the entry (API-attached).
    'mb-earth': { streams: [{ url: 'https://lang-a.example.com/master.m3u8', server: 'Ariel', language: 'english', type: 'hls' }], subtitles: [] },
    // b) `lang` alternative field.
    'mb-venus': { streams: [{ url: 'https://lang-b.example.com/master.m3u8', server: 'Venus', lang: 'English', type: 'hls' }], subtitles: [] },
    // c) NO language anywhere: the verified ROSTER language of the SERVER
    //    name (Enceladus = Hindi) applies.
    'mb-titan': { streams: [{ url: 'https://lang-c.example.com/master.m3u8', server: 'Enceladus', type: 'hls' }], subtitles: [] },
    // d) NO server field at all: the PROVIDER slug's roster language
    //    (mb-hyperion → Hyperion → Hindi).
    'mb-hyperion': { streams: [{ url: 'https://lang-d.example.com/master.m3u8', type: 'hls' }], subtitles: [] },
    // e) non-roster server with no language hint: language stays '' — never
    //    invented.
    'mb-mimas': { streams: [{ url: 'https://lang-e.example.com/master.m3u8', server: 'Mirror-7', type: 'hls' }], subtitles: [] },
    // f) the parenthetical is a language ONLY when it reads like one — a
    //    non-language parenthetical never becomes one.
    'mb-mars': { streams: [{ url: 'https://lang-f.example.com/master.m3u8', server: 'Mars (4K HDR)', type: 'hls' }], subtitles: [] }
  };
  try {
    const result = await scrapeVidCore('605', 'movie', undefined, undefined);
    const byUrl = new Map(result.sources.map((source) => [source.url, source]));
    ok(byUrl.get('https://lang-a.example.com/master.m3u8')!.language === 'English', '§9a the explicit language field wins (title-cased)');
    ok(byUrl.get('https://lang-b.example.com/master.m3u8')!.language === 'English', '§9b the lang alternative field is honored');
    ok(byUrl.get('https://lang-c.example.com/master.m3u8')!.server === 'Enceladus' && byUrl.get('https://lang-c.example.com/master.m3u8')!.language === 'Hindi', '§9c the roster language applies by server name (Enceladus → Hindi)');
    ok(byUrl.get('https://lang-d.example.com/master.m3u8')!.server === 'Hyperion' && byUrl.get('https://lang-d.example.com/master.m3u8')!.language === 'Hindi', '§9d the roster language applies by provider slug (mb-hyperion → Hindi)');
    ok(byUrl.get('https://lang-e.example.com/master.m3u8')!.server === 'Mirror-7' && byUrl.get('https://lang-e.example.com/master.m3u8')!.language === '', '§9e an unknown server keeps language "" — never invented');
    ok(byUrl.get('https://lang-f.example.com/master.m3u8')!.server === 'Mars (4K HDR)' && byUrl.get('https://lang-f.example.com/master.m3u8')!.language === 'English', '§9f a non-language parenthetical stays part of the name; the roster language still applies');
    ok(true, '§9 language ladder verified');
  } finally {
    restoreFetch();
  }
}

console.log(`\nvidcore_multi_server_test: ${passed} checks passed`);
