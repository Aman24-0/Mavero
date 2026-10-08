// MAVERO — LT-2 LiveGT V1 client layer: deterministic behavioral suite.
//
// Drives the REAL client modules (src/lib/client/live-tv/{api,cache,errors}.ts)
// against an in-process mocked global fetch — every LiveGT byte lives in this
// file as fixtures. NO live network: the suite is fully deterministic (the
// controlled live-contract verification is done separately during LT-2 and
// recorded in the worklog; per project convention this script is standalone
// and not yet chained into `pnpm test` — see LT-1 finding 1).
//
// Importing the modules under Node at all also proves they are SSR-safe
// (no top-level browser access — same argument as devtool_protection_test).
//
// Coverage map (LT-2 brief §16):
//   §1  errors module unit contract (status mapping, safe messages, guard)
//   §2  catalogue: valid/empty/malformed, optional fields, duplicates,
//       dropped entries, count ignored, URL shape, cache hit
//   §3  categories: extraction, local + remote filtering, key isolation
//   §4  search: remote q, empty query, caching, local case-insensitive
//   §5  channel resolution: non-DRM, ClearKey, multiple/empty/malformed
//       sources, 404 (NOT remapped), 400/429/5xx, network, malformed JSON,
//       local id gate, URL encoding, never cached, no embed/watch fallback
//   §6  DRM: normalization, missing key/keyId, unknown type, absent, values
//       never in error strings
//   §7  guide: valid/empty/absent-field, timestamp passthrough, malformed
//       shapes, dropped entries, nowPlaying degradation, caching
//   §8  cache module: TTL policy constants, expiry, write-copy, LRU bound,
//       clear, expired-data refresh at the api level
//   §9  security source-contract: no persistent storage APIs, no console,
//       single base-URL constant, no V2 paths
//   §10 abort/timeout: pre-aborted, abort during hang, stale-data race,
//       timeout classification, caller-abort precedence, signal wiring

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
        getLiveTvChannels,
        searchLiveTvChannels,
        resolveLiveTvPlayback,
        getLiveTvGuide,
        extractLiveTvCategories,
        filterLiveTvChannelsByCategory,
        filterLiveTvChannelsByQuery,
        LIVEGT_V1_BASE_URL,
        __test as apiTest
} from '$lib/client/live-tv/api';
import {
        LIVE_TV_CATALOGUE_TTL_MS,
        LIVE_TV_GUIDE_TTL_MS,
        clearLiveTvCache,
        liveTvCacheStats,
        setCachedLiveTvChannels,
        getCachedLiveTvChannels,
        setCachedLiveTvGuide,
        getCachedLiveTvGuide,
        __test as cacheTest
} from '$lib/client/live-tv/cache';
import {
        LiveTvError,
        isLiveTvError,
        liveTvErrorKindForStatus
} from '$lib/client/live-tv/errors';
import type { LiveTvChannel, LiveTvErrorKind } from '$lib/client/live-tv/types';

let passed = 0;
function ok(label: string): void {
        passed++;
        console.log(`  ok ${passed} - ${label}`);
}

// ============================================================
// Mock layer — LiveGT-shaped fixtures, intercepted fetch.
// ============================================================

const originalFetch = globalThis.fetch;
type MockCall = { url: string; signal: AbortSignal | undefined; cache: string | undefined };
let calls: MockCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
        return new Response(JSON.stringify(body), {
                status,
                headers: { 'content-type': 'application/json' }
        });
}

type MockHandler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

function installMock(handler: MockHandler): void {
        calls = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = new URL(String(input));
                const signal = (init?.signal as AbortSignal | undefined) ?? undefined;
                calls.push({ url: url.toString(), signal, cache: init?.cache as string | undefined });
                return handler(url, init);
        }) as typeof fetch;
}

function restoreFetch(): void {
        globalThis.fetch = originalFetch;
}

function abortError(): DOMException {
        return new DOMException('The operation was aborted.', 'AbortError');
}

/** Never resolves until its (linked) signal aborts — like a slow real request. */
function hangingHandler(): MockHandler {
        return (_url, init) =>
                new Promise<Response>((_resolve, reject) => {
                        const signal = (init?.signal as AbortSignal | undefined) ?? undefined;
                        if (signal?.aborted) {
                                reject(abortError());
                                return;
                        }
                        signal?.addEventListener('abort', () => reject(abortError()), { once: true });
                });
}

async function expectLiveTvError(kind: LiveTvErrorKind, fn: () => Promise<unknown>): Promise<LiveTvError> {
        try {
                await fn();
        } catch (err) {
                assert.ok(isLiveTvError(err), `expected LiveTvError, got: ${String(err)}`);
                assert.equal(err.kind, kind, `expected kind "${kind}", got "${err.kind}"`);
                return err;
        }
        assert.fail(`expected LiveTvError kind "${kind}", but the call resolved`);
}

// Fixtures — SYNTHETIC stand-ins for LiveGT shapes (never real signed data).

const SIGNED_URL_A = 'https://cdn.example.com/live/aaa/index.mpd?__hdnea__=FAKE-ST~EX~SIGN-A';
const SIGNED_URL_B = 'https://cdn.example.com/live/bbb/index.mpd?__hdnea__=FAKE-ST~EX~SIGN-B';
const FIXTURE_KEY_ID = '11112222333344445555666677778888';
const FIXTURE_KEY = '9999aaaabbbbccccddddeeeeffff0000';

const catalogueBody = {
        count: 3,
        channels: [
                {
                        id: '143',
                        name: 'CNBC TV18 Prime',
                        category: 'English',
                        logo: 'https://img.example.com/cnbc.png',
                        embed: 'https://livetgtv.lovable.app/embed/143',
                        watch: 'https://livetgtv.lovable.app/watch/143'
                },
                { id: '144', name: 'ETV Telugu', category: 'Telugu', logo: 'https://img.example.com/etv.png' },
                { id: '200', name: 'Star Sports 1', category: 'Sports' }
        ]
};

const guideBody = {
        generatedAt: 1759900000,
        id: '144',
        nowPlaying: {
                title: 'News Now',
                desc: 'Live news coverage',
                category: 'News',
                start: 1759899900,
                stop: 1759900500,
                startTime: '6:00 PM',
                stopTime: '6:30 PM'
        },
        upNext: { title: 'Sports Round', start: 1759900500, stop: 1759901400 },
        upcoming: [
                { title: 'Sports Round', start: 1759900500, stop: 1759901400 },
                { title: 'Prime Debate', start: 1759901400, stop: 1759902300, desc: 'Debate' }
        ],
        guide: [
                { title: 'News Now', start: 1759899900, stop: 1759900500 },
                { title: 'Sports Round', start: 1759900500, stop: 1759901400 },
                { title: 'Morning Show', start: 1759902300, stop: 1759903200, image: 'https://img.example.com/m.jpg' }
        ]
};

function resolutionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
                id: '143',
                name: 'CNBC TV18 Prime',
                category: 'English',
                logo: 'https://img.example.com/cnbc.png',
                sources: [SIGNED_URL_A],
                embed: 'https://livetgtv.lovable.app/embed/143',
                ...overrides
        };
}

/** Route by path: /channels list, /channels/{id}, /guide/{id}. */
function makeHandler(routes: {
        channelsList?: unknown;
        channelById?: Record<string, unknown>;
        guideById?: Record<string, unknown>;
}): MockHandler {
        return (url) => {
                const segments = url.pathname.split('/').filter(Boolean); // ['api','public',...]
                if (segments[0] === 'api' && segments[1] === 'public' && segments[2] === 'channels') {
                        if (segments.length === 3) {
                                // `in` (not `??`) so a null body fixture is served as null.
                                const listBody = 'channelsList' in routes ? routes.channelsList : catalogueBody;
                                return jsonResponse(listBody);
                        }
                        const id = decodeURIComponent(segments[3] ?? '');
                        const body = routes.channelById?.[id];
                        if (body === undefined) return jsonResponse({ error: 'Channel not found' }, 404);
                        return jsonResponse(body);
                }
                if (segments[0] === 'api' && segments[1] === 'public' && segments[2] === 'guide') {
                        const id = decodeURIComponent(segments[3] ?? '');
                        const body = routes.guideById?.[id];
                        if (body === undefined) return jsonResponse({ error: 'Channel not found' }, 404);
                        return jsonResponse(body);
                }
                return jsonResponse({ error: 'unknown route' }, 404);
        };
}

// ============================================================
// §1 — errors module contract
// ============================================================
{
        assert.equal(liveTvErrorKindForStatus(200), null, '200 is not an error');
        assert.equal(liveTvErrorKindForStatus(204), null, '2xx is not an error');
        assert.equal(liveTvErrorKindForStatus(400), 'bad_request', '400 → bad_request');
        assert.equal(liveTvErrorKindForStatus(401), 'bad_request', 'unmapped 401 4xx → bad_request');
        assert.equal(liveTvErrorKindForStatus(404), 'not_found', '404 → not_found (observed behavior)');
        assert.equal(liveTvErrorKindForStatus(429), 'rate_limited', '429 → rate_limited');
        assert.equal(liveTvErrorKindForStatus(500), 'server', '500 → server');
        assert.equal(liveTvErrorKindForStatus(502), 'server', 'documented 502 → server');
        assert.equal(liveTvErrorKindForStatus(503), 'server', '503 → server');
        ok('1a. HTTP status → error kind mapping (400/404/429/5xx/2xx)');

        const err = new LiveTvError('not_found', { status: 404, channelId: '999999', endpoint: 'channel' });
        assert.equal(err.name, 'LiveTvError');
        assert.equal(err.kind, 'not_found');
        assert.equal(err.status, 404);
        assert.equal(err.channelId, '999999');
        assert.equal(err.endpoint, 'channel');
        assert.equal(typeof err.message, 'string');
        assert.ok(err.message.length > 0, 'safe message is non-empty');
        ok('1b. LiveTvError carries kind/status/channelId/endpoint with a fixed safe message');

        assert.equal(isLiveTvError(err), true, 'guard accepts LiveTvError');
        assert.equal(isLiveTvError(new Error('x')), false, 'guard rejects plain Error');
        assert.equal(isLiveTvError('x'), false, 'guard rejects strings');
        assert.equal(isLiveTvError(null), false, 'guard rejects null');
        ok('1c. isLiveTvError type guard');
}

// ============================================================
// §2 — catalogue
// ============================================================
{
        clearLiveTvCache();
        installMock(makeHandler({}));
        try {
                const channels = await getLiveTvChannels();
                assert.equal(channels.length, 3, 'all three fixture channels normalize');
                const first = channels[0] as LiveTvChannel;
                assert.equal(first.id, '143');
                assert.equal(first.name, 'CNBC TV18 Prime');
                assert.equal(first.category, 'English');
                assert.equal(first.logo, 'https://img.example.com/cnbc.png');
                assert.deepEqual(
                        Object.keys(first).sort(),
                        ['category', 'id', 'logo', 'name'],
                        'normalized channels carry ONLY the four mapped fields (no embed/watch)'
                );
                const noLogo = channels.find((c) => c.id === '200');
                assert.ok(noLogo, 'channel without logo is present');
                assert.equal(noLogo?.logo, undefined, 'missing logo → undefined');
                ok('2a. valid catalogue normalizes id/name/category/logo; embed/watch never leak');

                assert.equal(calls.length, 1, 'one fetch for the first call');
                assert.equal(calls[0]?.url, 'https://livetgtv.lovable.app/api/public/channels', 'exact full-catalogue URL (no params)');
                ok('2b. catalogue request hits the documented V1 endpoint');

                const again = await getLiveTvChannels();
                assert.equal(calls.length, 1, 'second call is a cache hit — no refetch');
                assert.deepEqual(again, channels, 'cached result equals the first result');
                ok('2c. catalogue cache hit (short-lived in-memory)');
        } finally {
                restoreFetch();
        }
}

{
        clearLiveTvCache();
        installMock(makeHandler({ channelsList: { count: 0, channels: [] } }));
        try {
                const empty = await getLiveTvChannels();
                assert.deepEqual(empty, [], 'empty catalogue is a valid empty state, not an error');
                ok('2d. empty catalogue → []');
        } finally {
                restoreFetch();
        }
}

{
        clearLiveTvCache();
        const malformed: unknown[] = [
                null,
                'nope',
                [],
                {},
                { channels: 'not-an-array' },
                { count: 2 }
        ];
        for (const body of malformed) {
                installMock(makeHandler({ channelsList: body }));
                try {
                        await expectLiveTvError('invalid_response', () => getLiveTvChannels({ forceRefetch: true }));
                } finally {
                        restoreFetch();
                }
        }
        ok('2e. malformed top-level catalogue responses → invalid_response (never faked channels)');
}

{
        clearLiveTvCache();
        installMock(
                makeHandler({
                        channelsList: {
                                count: 9999,
                                channels: [
                                        { name: 'No Id At All', category: 'News' },
                                        { id: '', name: 'Empty Id' },
                                        { id: '   ', name: 'Blank Id' },
                                        { id: '7', name: 123 },
                                        { id: '4', name: 'Valid One' },
                                        { id: '5', name: 'Valid Two', category: null, logo: null },
                                        { id: '4', name: 'Duplicate Of Valid One' },
                                        'string entry',
                                        null
                                ]
                        }
                })
        );
        try {
                const channels = await getLiveTvChannels();
                assert.deepEqual(
                        channels.map((c) => c.id),
                        ['4', '5'],
                        'malformed entries dropped; duplicate id keeps the FIRST occurrence'
                );
                assert.equal(channels[0]?.name, 'Valid One', 'first occurrence wins on duplicate ids');
                assert.equal(channels[1]?.category, undefined, 'null category → undefined (optional field safe)');
                assert.equal(channels[1]?.logo, undefined, 'null logo → undefined (optional field safe)');
                assert.equal(channels.length, 2, 'wire count claims 9999 but only the 2 valid array entries are returned');
                ok('2f. malformed/duplicate entries handled safely; null optional fields → undefined; wire count ignored');
        } finally {
                restoreFetch();
        }
}

// ============================================================
// §3 — categories
// ============================================================
{
        const channels: LiveTvChannel[] = [
                { id: '1', name: 'A', category: 'Sports' },
                { id: '2', name: 'B', category: 'English' },
                { id: '3', name: 'C', category: 'Sports ' },
                { id: '4', name: 'D' },
                { id: '5', name: 'E', category: '' },
                { id: '6', name: 'F', category: 'News' }
        ];
        const categories = extractLiveTvCategories(channels);
        assert.deepEqual(categories, ['Sports', 'English', 'News'], 'unique, trimmed, first-appearance order; empty/missing ignored');
        ok('3a. category extraction derives from data (no hardcoded names)');

        assert.deepEqual(
                filterLiveTvChannelsByCategory(channels, 'sports').map((c) => c.id),
                ['1', '3'],
                'local category filter is case-insensitive and trims'
        );
        assert.deepEqual(filterLiveTvChannelsByCategory(channels, 'Movies'), [], 'non-matching category → empty');
        const noOp = filterLiveTvChannelsByCategory(channels, '   ');
        assert.equal(noOp.length, channels.length, 'empty category filter is a no-op');
        assert.notEqual(noOp, channels, 'no-op filter returns a copy');
        ok('3b. local category filter (case-insensitive, no-op copy)');
}

{
        clearLiveTvCache();
        installMock(makeHandler({}));
        try {
                const sports = await getLiveTvChannels({ category: ' Sports ' });
                assert.equal(calls[0]?.url, 'https://livetgtv.lovable.app/api/public/channels?category=Sports', 'remote category param is trimmed and sent');
                assert.equal(sports.length, 3, 'fixture routed regardless of category (mock does not filter)');
                await getLiveTvChannels({ category: 'Sports' });
                assert.equal(calls.length, 1, 'same category key → cache hit');
                await getLiveTvChannels({ category: 'News' });
                assert.equal(calls.length, 2, 'different category key → separate fetch');
                ok('3c. remote category filtering (documented ?category=) with per-key caching');
        } finally {
                restoreFetch();
        }
}

// ============================================================
// §4 — search
// ============================================================
{
        clearLiveTvCache();
        installMock(makeHandler({ channelsList: { count: 1, channels: [catalogueBody.channels[0]] } }));
        try {
                const results = await searchLiveTvChannels('star');
                assert.equal(calls[0]?.url, 'https://livetgtv.lovable.app/api/public/channels?q=star', 'remote search sends the documented ?q= param');
                assert.equal(results.length, 1, 'search results are normalized channels');
                await searchLiveTvChannels('star');
                assert.equal(calls.length, 1, 'same query → cache hit');
                await searchLiveTvChannels('sports');
                assert.equal(calls.length, 2, 'different query → separate fetch');
                ok('4a. remote search (?q=) with per-query caching');

                calls = [];
                await searchLiveTvChannels('');
                await searchLiveTvChannels('   ');
                assert.equal(calls.length, 1, 'empty/whitespace query delegates to the FULL catalogue (one shared call)');
                assert.equal(calls[0]?.url, 'https://livetgtv.lovable.app/api/public/channels', 'no q param is sent for an empty query');
                ok('4b. empty query → full catalogue, no pointless ?q request');
        } finally {
                restoreFetch();
        }
}

{
        const channels: LiveTvChannel[] = [
                { id: '1', name: 'CNBC TV18 Prime' },
                { id: '2', name: 'Star Sports 1' },
                { id: '3', name: 'Aastha Bhakti' }
        ];
        assert.deepEqual(
                filterLiveTvChannelsByQuery(channels, 'cnbc').map((c) => c.id),
                ['1'],
                'local search is case-insensitive'
        );
        assert.deepEqual(
                filterLiveTvChannelsByQuery(channels, 'STAR').map((c) => c.id),
                ['2'],
                'local search matches case-insensitively in the other direction'
        );
        assert.deepEqual(filterLiveTvChannelsByQuery(channels, 'zzz'), [], 'no match → empty');
        const all = filterLiveTvChannelsByQuery(channels, '  ');
        assert.equal(all.length, 3, 'empty local query returns every channel');
        assert.notEqual(all, channels, 'empty local query returns a copy');
        ok('4c. local search utility (case-insensitive substring on name)');
}

// ============================================================
// §5 — channel resolution
// ============================================================
{
        clearLiveTvCache();
        installMock(makeHandler({ channelById: { '143': resolutionBody() }, guideById: { '143': guideBody } }));
        try {
                const resolution = await resolveLiveTvPlayback('143');
                assert.equal(resolution.channel.id, '143', 'channel identity is the requested id');
                assert.equal(resolution.channel.name, 'CNBC TV18 Prime');
                assert.deepEqual(resolution.sources, [{ url: SIGNED_URL_A }], 'signed source URL is transported as-is');
                assert.equal(resolution.drm, null, 'absent drm → null');
                assert.deepEqual(
                        Object.keys(resolution.sources[0] as object).sort(),
                        ['url'],
                        'source objects carry only the url field'
                );
                ok('5a. valid non-DRM resolution → { channel, sources, drm: null }');

                await resolveLiveTvPlayback('143');
                assert.equal(calls.length, 2, 'resolution is NEVER cached — every call refetches (fresh signed URL)');
                const stats = liveTvCacheStats();
                assert.equal(stats.catalogueEntries, 0, 'resolution touches no catalogue cache');
                assert.equal(stats.guideEntries, 0, 'resolution touches no guide cache');
                ok('5b. playback resolution is never cached (fresh on every call; no persistent state)');

                // LT-11 cache-safety: the playback-resolution fetch must
                // bypass the BROWSER HTTP cache too (the upstream serves
                // `cache-control: public, max-age=60`; signed URLs must be
                // re-resolved on every call — never replayed, never persisted).
                assert.equal(
                        calls[1]?.cache,
                        'no-store',
                        '5c: playback-resolution fetch sets cache: no-store (browser HTTP cache bypassed)'
                );
                // Catalogue and guide keep DEFAULT bounded caching (their
                // data is not credential material and the in-memory cache
                // already bounds them).
                clearLiveTvCache();
                await getLiveTvChannels();
                assert.equal(calls[2]?.cache, 'default', '5c: catalogue fetch keeps default cache mode');
                await getLiveTvGuide('143');
                assert.equal(calls[3]?.cache, 'default', '5c: guide fetch keeps default cache mode');
                ok('5c. LT-11 cache contract: resolution=always-fresh (no-store); catalogue/guide=bounded default');
        } finally {
                restoreFetch();
        }
}

{
        clearLiveTvCache();
        installMock(
                makeHandler({
                        channelById: {
                                '143': resolutionBody({
                                        sources: [SIGNED_URL_A, SIGNED_URL_B],
                                        drm: { type: 'clearkey', keyId: FIXTURE_KEY_ID, key: FIXTURE_KEY }
                                })
                        }
                })
        );
        try {
                const resolution = await resolveLiveTvPlayback('143');
                assert.deepEqual(
                        resolution.sources.map((s) => s.url),
                        [SIGNED_URL_A, SIGNED_URL_B],
                        'multiple valid sources preserved in source order'
                );
                assert.deepEqual(
                        resolution.drm,
                        { type: 'clearkey', keyId: FIXTURE_KEY_ID, key: FIXTURE_KEY },
                        'valid ClearKey normalized with exact values'
                );
                assert.deepEqual(
                        Object.keys(resolution.drm as object).sort(),
                        ['key', 'keyId', 'type'],
                        'drm object carries only the three ClearKey fields'
                );
                ok('5c. multiple sources + valid ClearKey normalization');
        } finally {
                restoreFetch();
        }
}

{
        clearLiveTvCache();
        installMock(
                makeHandler({
                        channelById: {
                                empty: resolutionBody({ sources: [] }),
                                junk: resolutionBody({ sources: [SIGNED_URL_A, 'javascript:alert(1)', 'not a url', 42, null] }),
                                schemes: resolutionBody({ sources: ['javascript:alert(1)', 'ftp://x/y'] }),
                                notarray: resolutionBody({ sources: 'https://single-string.example/x.mpd' }),
                                embedonly: resolutionBody({ sources: [] })
                        }
                })
        );
        try {
                await expectLiveTvError('no_playback_source', () => resolveLiveTvPlayback('empty'));
                ok('5d. empty sources array → no_playback_source (controlled state, no fake fallback)');

                const mixed = await resolveLiveTvPlayback('junk');
                assert.deepEqual(
                        mixed.sources.map((s) => s.url),
                        [SIGNED_URL_A],
                        'only the usable http(s) URL survives; junk entries dropped'
                );
                ok('5e. malformed source entries dropped, valid ones kept');

                await expectLiveTvError('no_playback_source', () => resolveLiveTvPlayback('schemes'));
                ok('5f. all-invalid schemes (javascript:/ftp:) → no_playback_source');

                await expectLiveTvError('invalid_response', () => resolveLiveTvPlayback('notarray'));
                ok('5g. sources not an array → invalid_response');

                const embedErr = await expectLiveTvError('no_playback_source', () => resolveLiveTvPlayback('embedonly'));
                assert.ok(!embedErr.message.includes('embed'), 'error does not mention embed fallbacks');
                ok('5h. documented embed/watch fields are NEVER used as a playback fallback');
        } finally {
                restoreFetch();
        }
}

{
        clearLiveTvCache();
        installMock(makeHandler({}));
        try {
                const notFound = await expectLiveTvError('not_found', () => resolveLiveTvPlayback('999999'));
                assert.equal(notFound.status, 404, 'status preserved');
                assert.equal(notFound.endpoint, 'channel');
                ok('5i. unknown numeric id → 404 → not_found (observed live behavior preserved)');

                await expectLiveTvError('not_found', () => resolveLiveTvPlayback('not-a-number'));
                ok('5j. malformed id ("not-a-number") → live API 404 → not_found (NOT remapped to 400)');
        } finally {
                restoreFetch();
        }
}

{
        clearLiveTvCache();
        const handlerWithStatuses: MockHandler = (url) => {
                const id = decodeURIComponent(url.pathname.split('/').filter(Boolean)[3] ?? '');
                if (id === 'b400') return jsonResponse({ error: 'bad id' }, 400);
                if (id === 'b429') return jsonResponse({ error: 'slow down' }, 429);
                if (id === 'b500') return jsonResponse({ error: 'boom' }, 500);
                if (id === 'b502') return jsonResponse({ error: 'upstream down' }, 502);
                return jsonResponse(resolutionBody());
        };
        installMock(handlerWithStatuses);
        try {
                const bad = await expectLiveTvError('bad_request', () => resolveLiveTvPlayback('b400'));
                assert.equal(bad.status, 400, '400 status preserved');
                await expectLiveTvError('rate_limited', () => resolveLiveTvPlayback('b429'));
                await expectLiveTvError('server', () => resolveLiveTvPlayback('b500'));
                const upstream = await expectLiveTvError('server', () => resolveLiveTvPlayback('b502'));
                assert.equal(upstream.status, 502, 'documented 502 classified as server with status');
                ok('5k. HTTP 400/429/500/502 map to their normalized kinds');
        } finally {
                restoreFetch();
        }
}

{
        clearLiveTvCache();
        installMock(() => Promise.reject(new TypeError('fetch failed')));
        try {
                await expectLiveTvError('network', () => resolveLiveTvPlayback('143'));
                ok('5l. network failure → network');
        } finally {
                restoreFetch();
        }
}

{
        clearLiveTvCache();
        installMock(() => new Response('not json{', { status: 200, headers: { 'content-type': 'application/json' } }));
        try {
                await expectLiveTvError('invalid_response', () => resolveLiveTvPlayback('143'));
                ok('5m. HTTP 200 with malformed JSON → invalid_response');
        } finally {
                restoreFetch();
        }
}

{
        clearLiveTvCache();
        // Permissive: any channel id resolves, any guide id returns an empty guide —
        // this block is about URL CONSTRUCTION, not routing.
        installMock((url) => {
                const segments = url.pathname.split('/').filter(Boolean);
                if (segments[2] === 'guide') return jsonResponse({ nowPlaying: null, upNext: null, upcoming: [], guide: [] });
                return jsonResponse(resolutionBody());
        });
        try {
                calls = [];
                await expectLiveTvError('bad_request', () => resolveLiveTvPlayback(''));
                await expectLiveTvError('bad_request', () => resolveLiveTvPlayback('   '));
                assert.equal(calls.length, 0, 'client-side id gate rejects before any fetch');
                ok('5n. empty/whitespace channel id → bad_request without a network call');

                await resolveLiveTvPlayback('a b/c?d');
                assert.equal(
                        calls[0]?.url,
                        'https://livetgtv.lovable.app/api/public/channels/a%20b%2Fc%3Fd',
                        'channel id is URL-encoded into the path (no path traversal / param injection)'
                );
                ok('5o. channel id URL encoding');

                await getLiveTvGuide('x#y');
                assert.equal(calls[1]?.url, 'https://livetgtv.lovable.app/api/public/guide/x%23y', 'guide ids are encoded too');
                ok('5p. guide channel id URL encoding');
        } finally {
                restoreFetch();
        }
}

// ============================================================
// §6 — DRM validation
// ============================================================
{
        clearLiveTvCache();
        installMock(
                makeHandler({
                        channelById: {
                                nokey: resolutionBody({ drm: { type: 'clearkey', keyId: FIXTURE_KEY_ID } }),
                                nokeyid: resolutionBody({ drm: { type: 'clearkey', key: FIXTURE_KEY } }),
                                widevine: resolutionBody({ drm: { type: 'widevine', keyId: FIXTURE_KEY_ID, key: FIXTURE_KEY } }),
                                drmstring: resolutionBody({ drm: 'clearkey' }),
                                drmnum: resolutionBody({ drm: { type: 123, keyId: FIXTURE_KEY_ID, key: FIXTURE_KEY } }),
                                nulldrm: resolutionBody({ drm: null })
                        }
                })
        );
        try {
                await expectLiveTvError('invalid_response', () => resolveLiveTvPlayback('nokey'));
                ok('6a. ClearKey missing key → invalid_response');

                await expectLiveTvError('invalid_response', () => resolveLiveTvPlayback('nokeyid'));
                ok('6b. ClearKey missing keyId → invalid_response');

                const unknown = await expectLiveTvError('unsupported_drm', () => resolveLiveTvPlayback('widevine'));
                assert.ok(!unknown.message.includes(FIXTURE_KEY_ID), 'error message contains no keyId material');
                assert.ok(!unknown.message.includes(FIXTURE_KEY), 'error message contains no key material');
                ok('6c. unknown DRM type → unsupported_drm (never silently treated as ClearKey)');

                await expectLiveTvError('invalid_response', () => resolveLiveTvPlayback('drmstring'));
                await expectLiveTvError('invalid_response', () => resolveLiveTvPlayback('drmnum'));
                ok('6d. non-object / non-string-type drm → invalid_response');

                const nullDrm = await resolveLiveTvPlayback('nulldrm');
                assert.equal(nullDrm.drm, null, 'explicit drm:null → null');
                ok('6e. explicit null drm → null');

                // Every failure path above must carry only the fixed safe message:
                // no keyId, no key, no signed URL fragments anywhere in the error.
                const failingIds = ['nokey', 'nokeyid', 'widevine', 'drmstring', 'drmnum'];
                for (const id of failingIds) {
                        await resolveLiveTvPlayback(id).then(
                                () => assert.fail(`${id} unexpectedly resolved`),
                                (err: unknown) => {
                                        const text = String(err);
                                        assert.ok(!text.includes(FIXTURE_KEY_ID), `${id}: no keyId material in error`);
                                        assert.ok(!text.includes(FIXTURE_KEY), `${id}: no key material in error`);
                                        assert.ok(!text.includes(SIGNED_URL_A), `${id}: no signed URL in error`);
                                }
                        );
                }
                ok('6f. DRM values never appear in error strings (fixed safe-message table)');
        } finally {
                restoreFetch();
        }
}

// ============================================================
// §7 — guide / EPG
// ============================================================
{
        clearLiveTvCache();
        installMock(makeHandler({ guideById: { '144': guideBody } }));
        try {
                const guide = await getLiveTvGuide('144');
                assert.equal(guide.channelId, '144', 'guide identity is the requested channel id');
                assert.equal(guide.nowPlaying?.title, 'News Now');
                assert.equal(guide.nowPlaying?.description, 'Live news coverage', 'wire desc → description');
                assert.equal(guide.nowPlaying?.category, 'News');
                assert.equal(guide.nowPlaying?.startSeconds, 1759899900, 'wire start → startSeconds (Unix seconds, unchanged)');
                assert.equal(guide.nowPlaying?.stopSeconds, 1759900500, 'wire stop → stopSeconds (Unix seconds, unchanged)');
                assert.equal(guide.nowPlaying?.startDisplay, '6:00 PM', 'wire startTime → startDisplay');
                assert.equal(guide.nowPlaying?.stopDisplay, '6:30 PM', 'wire stopTime → stopDisplay');
                assert.deepEqual(
                        Object.keys(guide.nowPlaying as object).sort(),
                        ['category', 'description', 'startDisplay', 'startSeconds', 'stopDisplay', 'stopSeconds', 'title'],
                        'programme objects carry only mapped fields'
                );
                assert.equal(guide.upNext?.title, 'Sports Round');
                assert.equal(guide.upcoming.length, 2);
                assert.equal(guide.schedule.length, 3);
                assert.equal(guide.schedule[2]?.image, 'https://img.example.com/m.jpg', 'schedule image preserved');
                assert.equal(guide.generatedAtSeconds, 1759900000, 'generatedAt → generatedAtSeconds');
                ok('7a. valid guide normalizes nowPlaying/upNext/upcoming/schedule with mapped fields');

                await getLiveTvGuide('144');
                assert.equal(calls.length, 1, 'second guide call within TTL is a cache hit');
                await getLiveTvGuide('144', { forceRefetch: true });
                assert.equal(calls.length, 2, 'forceRefetch bypasses the guide cache');
                ok('7b. guide short cache + forceRefetch');
        } finally {
                restoreFetch();
        }
}

{
        clearLiveTvCache();
        installMock(makeHandler({ guideById: { '144': { nowPlaying: null, upNext: null, upcoming: [], guide: [] } } }));
        try {
                const empty = await getLiveTvGuide('144');
                assert.equal(empty.nowPlaying, null);
                assert.equal(empty.upNext, null);
                assert.deepEqual(empty.upcoming, []);
                assert.deepEqual(empty.schedule, []);
                ok('7c. empty guide is a VALID empty state, never an error');
        } finally {
                restoreFetch();
        }
}

{
        clearLiveTvCache();
        installMock(makeHandler({ guideById: { '144': {} } }));
        try {
                const absent = await getLiveTvGuide('144');
                assert.equal(absent.nowPlaying, null, 'absent nowPlaying → null');
                assert.equal(absent.upNext, null, 'absent upNext → null');
                assert.deepEqual(absent.upcoming, [], 'absent upcoming → []');
                assert.deepEqual(absent.schedule, [], 'absent guide → []');
                assert.equal(absent.generatedAtSeconds, undefined, 'absent generatedAt → undefined');
                ok('7d. absent optional guide fields degrade to the empty contract');
        } finally {
                restoreFetch();
        }
}

{
        clearLiveTvCache();
        const badGuides: Record<string, unknown> = {
                g1: null,
                g2: 'nope',
                g3: { upcoming: 'not-an-array' },
                g4: { guide: {} },
                g5: { nowPlaying: { title: 'X', start: 'not-a-number', stop: 123 } }
        };
        installMock(makeHandler({ guideById: badGuides }));
        try {
                await expectLiveTvError('invalid_response', () => getLiveTvGuide('g1', { forceRefetch: true }));
                await expectLiveTvError('invalid_response', () => getLiveTvGuide('g2', { forceRefetch: true }));
                await expectLiveTvError('invalid_response', () => getLiveTvGuide('g3', { forceRefetch: true }));
                await expectLiveTvError('invalid_response', () => getLiveTvGuide('g4', { forceRefetch: true }));
                const degraded = await getLiveTvGuide('g5', { forceRefetch: true });
                assert.equal(degraded.nowPlaying, null, 'malformed nowPlaying programme → null (documented degradation)');
                ok('7e. malformed guide shapes → invalid_response; malformed programme slot → null');

                calls = [];
                await expectLiveTvError('not_found', () => getLiveTvGuide('999', { forceRefetch: true }));
                assert.ok(calls[0]?.url.endsWith('/api/public/guide/999'), 'guide fetches the documented endpoint');
                ok('7f. unknown guide id → 404 → not_found');
        } finally {
                restoreFetch();
        }
}

{
        clearLiveTvCache();
        installMock(
                makeHandler({
                        guideById: {
                                '144': {
                                        nowPlaying: null,
                                        upNext: null,
                                        upcoming: [
                                                { title: 'Valid', start: 1, stop: 2 },
                                                { no: 'title' },
                                                { title: 'Bad Start', start: 'x', stop: 2 },
                                                { title: 'Bad Stop', start: 1, stop: Infinity },
                                                'string',
                                                null
                                        ],
                                        guide: []
                                }
                        }
                })
        );
        try {
                const guide = await getLiveTvGuide('144');
                assert.deepEqual(
                        guide.upcoming.map((p) => p.title),
                        ['Valid'],
                        'malformed programme entries are dropped, valid ones kept'
                );
                ok('7g. malformed programme entries dropped safely');
        } finally {
                restoreFetch();
        }
}

// ============================================================
// §8 — cache module policy
// ============================================================
{
        assert.equal(LIVE_TV_CATALOGUE_TTL_MS, 5 * 60_000, 'catalogue TTL is 5 minutes (policy contract)');
        assert.equal(LIVE_TV_GUIDE_TTL_MS, 30_000, 'guide TTL is 30 seconds (policy contract)');
        const stats = liveTvCacheStats();
        assert.ok(stats.catalogueMaxEntries > 0 && stats.catalogueMaxEntries <= 32, 'catalogue cache is bounded');
        assert.ok(stats.guideMaxEntries > 0 && stats.guideMaxEntries <= 128, 'guide cache is bounded');
        ok('8a. cache TTL/bound policy constants (5 min catalogue / 30 s guide / bounded)');
}

{
        clearLiveTvCache();
        const channels: LiveTvChannel[] = [{ id: '1', name: 'One' }];
        const T = 1_000_000;
        setCachedLiveTvChannels('k', channels, T);
        assert.deepEqual(getCachedLiveTvChannels('k', T + LIVE_TV_CATALOGUE_TTL_MS - 1), channels, 'hit just inside TTL');
        assert.equal(getCachedLiveTvChannels('k', T + LIVE_TV_CATALOGUE_TTL_MS + 1), undefined, 'miss just past TTL (no stale data)');
        ok('8b. catalogue cache expiry');

        const guide = {
                channelId: '144',
                nowPlaying: null,
                upNext: null,
                upcoming: [],
                schedule: []
        };
        setCachedLiveTvGuide('144', guide, T);
        assert.deepEqual(getCachedLiveTvGuide('144', T + LIVE_TV_GUIDE_TTL_MS - 1), guide, 'guide hit inside 30 s');
        assert.equal(getCachedLiveTvGuide('144', T + LIVE_TV_GUIDE_TTL_MS + 1), undefined, 'guide miss past 30 s');
        ok('8c. guide cache expiry (short 30-second window)');
}

{
        clearLiveTvCache();
        const channels: LiveTvChannel[] = [{ id: '1', name: 'One' }];
        setCachedLiveTvChannels('k', channels);
        channels.push({ id: '2', name: 'Two' });
        assert.equal(getCachedLiveTvChannels('k')?.length, 1, 'cached array is a copy — caller mutations cannot corrupt the cache');
        ok('8d. cache write copies the value');
}

{
        clearLiveTvCache();
        for (let i = 0; i < 20; i++) {
                setCachedLiveTvChannels(`key-${i}`, []);
        }
        assert.ok(liveTvCacheStats().catalogueEntries <= liveTvCacheStats().catalogueMaxEntries, 'LRU eviction bounds the catalogue cache');
        clearLiveTvCache();
        assert.deepEqual(liveTvCacheStats(), {
                catalogueEntries: 0,
                guideEntries: 0,
                catalogueTtlMs: LIVE_TV_CATALOGUE_TTL_MS,
                guideTtlMs: LIVE_TV_GUIDE_TTL_MS,
                catalogueMaxEntries: liveTvCacheStats().catalogueMaxEntries,
                guideMaxEntries: liveTvCacheStats().guideMaxEntries
        }, 'clearLiveTvCache evicts everything');
        ok('8e. LRU bound + clearLiveTvCache');
}

{
        // Expired data never survives at the API level: pre-expire an entry, then
        // verify the api refetches instead of serving it.
        clearLiveTvCache();
        installMock(makeHandler({}));
        try {
                setCachedLiveTvChannels('', [{ id: 'old', name: 'Stale' }], Date.now() - LIVE_TV_CATALOGUE_TTL_MS - 1_000);
                const fresh = await getLiveTvChannels();
                assert.equal(calls.length, 1, 'expired entry → refetch');
                assert.equal(fresh[0]?.id, '143', 'fresh (fixture) data served, not the stale entry');
                ok('8f. expired data refresh (api refetches past TTL)');
        } finally {
                restoreFetch();
        }
}

// ============================================================
// §9 — security source-contract
// ============================================================
{
        const here = path.dirname(fileURLToPath(import.meta.url));
        const moduleDir = path.resolve(here, '../src/lib/client/live-tv');
        const sources: Record<string, string> = {
                api: readFileSync(path.join(moduleDir, 'api.ts'), 'utf8'),
                cache: readFileSync(path.join(moduleDir, 'cache.ts'), 'utf8'),
                errors: readFileSync(path.join(moduleDir, 'errors.ts'), 'utf8'),
                types: readFileSync(path.join(moduleDir, 'types.ts'), 'utf8')
        };
        const all = Object.values(sources).join('\n');

        assert.ok(!/localStorage\.|sessionStorage\.|indexedDB\./i.test(all), 'no persistent storage API usage (dotted access) anywhere in the live-tv module');
        ok('9a. no localStorage/sessionStorage/IndexedDB usage');

        assert.ok(!/console\./.test(all), 'zero console calls — nothing (incl. signed URLs / DRM) can be logged from this module');
        ok('9b. no console logging in the live-tv module');

        assert.ok(!/@supabase|createClient|supabaseClient/.test(all), 'no Supabase usage in the live-tv module');
        ok('9c. no Supabase usage');

        assert.ok(!all.includes('/api/public/v2'), 'no V2 endpoint path anywhere (V1 only)');
        ok('9d. no LiveGT V2 endpoint strings');

        assert.ok(sources.api.includes('export const LIVEGT_V1_BASE_URL'), 'the single base-URL constant is exported from api.ts');
        assert.ok(sources.api.includes(LIVEGT_V1_BASE_URL), 'constant value matches');
        for (const [name, source] of Object.entries(sources)) {
                if (name === 'api') continue;
                assert.ok(!source.includes('livetgtv.lovable.app'), `hostname must not be scattered into ${name}.ts`);
        }
        assert.ok(!sources.api.slice(sources.api.indexOf('LIVEGT_V1_BASE_URL =') + 40).includes("= 'https://livetgtv.lovable.app'"), 'no second base-URL assignment');
        ok('9e. single LiveGT base URL constant (hostname not scattered)');
}

// ============================================================
// §10 — abort / timeout lifecycle
// ============================================================
{
        clearLiveTvCache();
        installMock(makeHandler({}));
        try {
                calls = [];
                const ac = new AbortController();
                ac.abort();
                await expectLiveTvError('aborted', () => getLiveTvChannels({ signal: ac.signal }));
                await expectLiveTvError('aborted', () => resolveLiveTvPlayback('143', { signal: ac.signal }));
                await expectLiveTvError('aborted', () => getLiveTvGuide('144', { signal: ac.signal }));
                assert.equal(calls.length, 0, 'pre-aborted signals never trigger a fetch');
                ok('10a. pre-aborted signal → immediate "aborted" for all three operations, zero fetches');
        } finally {
                restoreFetch();
        }
}

{
        clearLiveTvCache();
        installMock(hangingHandler());
        try {
                const ac = new AbortController();
                const promise = resolveLiveTvPlayback('143', { signal: ac.signal });
                setTimeout(() => ac.abort(), 20);
                await expectLiveTvError('aborted', () => promise);
                ok('10b. abort during an in-flight request → "aborted"');
        } finally {
                restoreFetch();
        }
}

{
        // The channel-switch race: A hangs, user picks B — A must never resolve
        // with data and B's data must be what the caller sees.
        clearLiveTvCache();
        const ac = new AbortController();
        const switcher: MockHandler = (url, init) => {
                const id = decodeURIComponent(url.pathname.split('/').filter(Boolean)[3] ?? '');
                if (id === '111') return hangingHandler()(url, init);
                return jsonResponse(resolutionBody({ id: '222', name: 'Channel B', sources: [SIGNED_URL_B] }));
        };
        installMock(switcher);
        try {
                const promiseA = resolveLiveTvPlayback('111', { signal: ac.signal });
                ac.abort();
                const resolutionB = await resolveLiveTvPlayback('222');
                await expectLiveTvError('aborted', () => promiseA);
                assert.equal(resolutionB.channel.id, '222', 'caller receives B data, not stale A data');
                assert.deepEqual(resolutionB.sources.map((s) => s.url), [SIGNED_URL_B]);
                ok('10c. stale aborted request produces no success data (channel-switch race)');
        } finally {
                restoreFetch();
        }
}

{
        clearLiveTvCache();
        apiTest.setRequestTimeoutForTests(25);
        try {
                installMock(hangingHandler());
                const timeoutErr = await expectLiveTvError('timeout', () => resolveLiveTvPlayback('143'));
                assert.equal(timeoutErr.endpoint, 'channel', 'timeout carries endpoint context');
                await expectLiveTvError('timeout', () => getLiveTvChannels({ forceRefetch: true }));
                await expectLiveTvError('timeout', () => getLiveTvGuide('144', { forceRefetch: true }));
                ok('10d. hanging request times out with kind "timeout" (all operations)');
        } finally {
                restoreFetch();
                apiTest.resetRequestTimeout();
        }
}

{
        clearLiveTvCache();
        apiTest.setRequestTimeoutForTests(80);
        try {
                installMock(hangingHandler());
                const ac = new AbortController();
                const promise = getLiveTvChannels({ signal: ac.signal });
                setTimeout(() => ac.abort(), 20); // abort BEFORE the internal timeout
                await expectLiveTvError('aborted', () => promise);
                ok('10e. caller abort takes precedence over the internal timeout');
        } finally {
                restoreFetch();
                apiTest.resetRequestTimeout();
        }
}

{
        clearLiveTvCache();
        installMock(makeHandler({}));
        try {
                await getLiveTvChannels();
                const signal = calls[0]?.signal;
                assert.ok(signal instanceof AbortSignal, 'an AbortSignal is wired into the underlying fetch');
                assert.ok(!signal?.aborted, 'the linked signal is live while the request runs');
                assert.ok(apiTest.getRequestTimeoutMs() > 0, 'default timeout is positive');
                ok('10f. AbortSignal is passed through to fetch; default timeout sane');
        } finally {
                restoreFetch();
        }
}

console.log(`\nlive_tv_client_test: ${passed} checks passed (LT-2 LiveGT V1 client layer contract).`);
