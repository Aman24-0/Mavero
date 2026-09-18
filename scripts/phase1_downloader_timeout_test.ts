import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveAddonDownloads } from '$lib/server/streaming/stremio/addon-download-service';
import type { StreamingAddon } from '$lib/shared/streaming-addons';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Phase 1 (audit STM-01) — downloader aggregate timeout + bounded concurrency.
 *
 * Problem: the batch endpoint documented a ~40s overall budget, but the
 * AbortController's signal never reached the network layer
 * (`resolveAddonOnce` did not forward it to `fetchStremioStreamResponse`)
 * — the budget was DEAD CODE, and the batch ran an UNBOUNDED `Promise.all`
 * over the configured addon set (up to 20 simultaneous upstream fetches).
 *
 * Fix:
 *   1. the aggregate signal is forwarded through `resolveAddonOnce` into
 *      `fetchStremioStreamResponse` (which already supported `overallSignal`
 *      — the player path passes it; the downloader now does too);
 *   2. the unbounded Promise.all is a BOUNDED concurrency pool;
 *   3. addons not yet started when the budget expires terminate immediately
 *      (failed/TIMEOUT) instead of opening new fetches;
 *   4. per-addon failure isolation and result ordering are preserved.
 *
 * REAL behavioral tests: the actual `resolveAddonDownloads` service runs
 * with instrumented fetchers/loaders (no network, no DB).
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const REQUEST = { mediaType: 'movie' as const, contentId: 'movie-8633518', tmdbId: '8633518' };
const CLIENT = { from: () => { throw new Error('no DB in tests'); } } as unknown as SupabaseClient;

function addon(index: number, slug: string): StreamingAddon {
  return {
    id: `00000000-0000-4000-8000-1${String(index).padStart(11, '0')}`,
    name: `Addon ${slug}`,
    slug,
    manifestUrl: `https://${slug}.example/manifest.json`,
    enabled: true,
    status: 'experimental',
    ordering: index,
    supportedTypes: ['movie'],
    idPrefixes: ['tt'],
    resources: ['catalog', 'meta', 'stream'],
    capabilities: { supportsStream: true, manifestId: `community.${slug}`, normalizedAt: new Date().toISOString(), streamTypes: ['movie'], streamIdPrefixes: ['tt'], idProperties: ['imdb_id'] },
  } as unknown as StreamingAddon;
}

function okResponse(url: string): Response {
  return new Response(JSON.stringify({ streams: [{ url: 'https://media.example/video.m3u8', title: 'S' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

type FetchProbe = { url: string; signal: AbortSignal };

/** A fetcher that hangs until its own abort signal fires. */
function hangingFetcher(probes: FetchProbe[]) {
  return ((_url: string | URL, init?: RequestInit) => {
    const signal = init?.signal;
    probes.push({ url: String(_url), signal: signal as AbortSignal });
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  }) as unknown as typeof fetch;
}

// The SSRF preflight re-validates DNS answers — inject a public resolver so
// the instrumented fetchers are actually reached (no network in tests).
const fakeDns = (async () => [{ address: '93.184.216.34', family: 4 }]);

const baseDeps = {
  loadContent: async () => ({ identifiers: { imdbId: 'tt8633518' } }),
  dnsResolver: fakeDns,
};

// ============================================================
// 1. The aggregate budget actually ABORTS the child fetches
// ============================================================

{
  const probes: FetchProbe[] = [];
  const result = await resolveAddonDownloads(CLIENT, REQUEST, {
    ...baseDeps,
    loadAddons: async () => [addon(0, 'slow-a'), addon(1, 'slow-b')],
    fetcher: hangingFetcher(probes),
    overallTimeoutMs: 60, // aggregate budget expires fast
    timeoutMs: 30_000, // per-attempt timeout far beyond the budget
  });
  assert.ok(probes.length >= 2, 'both addon fetches were opened');
  for (const probe of probes) {
    assert.ok(probe.signal, 'the fetch received an abort signal (the aggregate controller)');
    assert.equal(probe.signal.aborted, true, 'the aggregate budget ABORTED the in-flight fetch');
  }
  assert.ok(result.groups.every((group) => group.status === 'failed' && group.errorCode === 'TIMEOUT'), 'hanging addons end failed/TIMEOUT when the aggregate budget expires');
  ok(true, '1. aggregate timeout aborts in-flight child fetches (the 40s budget is no longer dead code)');
}

// ============================================================
// 2. Partial results survive individual addon failures
// ============================================================

{
  const probes: FetchProbe[] = [];
  const result = await resolveAddonDownloads(CLIENT, REQUEST, {
    ...baseDeps,
    loadAddons: async () => [addon(0, 'healthy'), addon(1, 'hanging')],
    fetcher: ((_url: string | URL, init?: RequestInit) => {
      const url = String(_url);
      const signal = init?.signal;
      if (url.includes('healthy')) {
        return Promise.resolve(okResponse(url));
      }
      probes.push({ url, signal: signal as AbortSignal });
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }) as unknown as typeof fetch,
    overallTimeoutMs: 80,
  });
  const healthy = result.groups.find((group) => group.addonSlug === 'healthy');
  const hanging = result.groups.find((group) => group.addonSlug === 'hanging');
  assert.equal(healthy?.status, 'loaded', 'the healthy addon still resolved');
  assert.ok((healthy?.streams ?? []).length >= 1, 'the healthy addon kept its streams');
  assert.equal(hanging?.status, 'failed', 'the hanging addon failed alone');
  ok(true, '2. one hanging/failed addon does NOT fail the batch (isolation preserved)');
}

// ============================================================
// 3. Bounded concurrency is respected
// ============================================================

{
  let inFlight = 0;
  let peak = 0;
  const CONCURRENCY = 2;
  const addons = Array.from({ length: 9 }, (_, index) => addon(index, `a${index}`));
  const fetcher = (async (_url: string | URL) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 15));
    inFlight -= 1;
    return okResponse(String(_url));
  }) as unknown as typeof fetch;
  const result = await resolveAddonDownloads(CLIENT, REQUEST, {
    ...baseDeps,
    loadAddons: async () => addons,
    fetcher,
    addonConcurrency: CONCURRENCY,
  });
  assert.ok(peak <= CONCURRENCY, `peak in-flight fetches (${peak}) never exceeded the pool size (${CONCURRENCY}) — previously addons.length`);
  assert.equal(result.groups.length, 9, 'every addon produced a group');
  assert.ok(result.groups.every((group) => group.status === 'loaded'), 'all addons completed through the pool');
  // Ordering preserved: sorted by ordering index.
  assert.deepEqual(result.groups.map((group) => group.addonOrdering), [0, 1, 2, 3, 4, 5, 6, 7, 8], 'group ordering preserved through the pool');
  ok(true, '3. bounded concurrency pool replaces the unbounded Promise.all (ordering + completeness preserved)');
}

// ============================================================
// 4. Addons not yet started when the budget expires terminate immediately
// ============================================================

{
  const probes: FetchProbe[] = [];
  const addons = Array.from({ length: 8 }, (_, index) => addon(index, `b${index}`));
  const result = await resolveAddonDownloads(CLIENT, REQUEST, {
    ...baseDeps,
    loadAddons: async () => addons,
    fetcher: hangingFetcher(probes),
    overallTimeoutMs: 50,
    addonConcurrency: 2, // 8 addons through a pool of 2 — most never start
  });
  const notStarted = result.groups.filter((group) => group.errorCode === 'TIMEOUT');
  assert.ok(notStarted.length >= 2, `addons that never started terminate as failed/TIMEOUT (${notStarted.length} of 8)`);
  assert.equal(result.groups.length, 8, 'the result set remains complete');
  ok(true, '4. queue termination: unstarted addons end failed/TIMEOUT once the aggregate budget expires');
}

// ============================================================
// 5. Static wiring — the signal reaches the network layer
// ============================================================

const service = read('src/lib/server/streaming/stremio/addon-download-service.ts');
assert.match(service, /await resolveAddonOnce\(addon, plan\.plan, streamType, runtimeContext, 1, deps, controller\.signal\)/, 'the batch path forwards the aggregate signal to resolveAddonOnce');
assert.match(service, /\.\.\.\(overallSignal \? \{ overallSignal \} : \{\}\),/, 'resolveAddonOnce forwards overallSignal into the fetch deps');
assert.doesNotMatch(service, /const groups = await Promise\.all\(considered\.map\(/, 'the unbounded Promise.all is gone');
assert.match(service, /ADDON_CONCURRENCY/, 'the bounded pool constant exists');
const fetcher = read('src/lib/server/streaming/stremio/stream-fetch.ts');
assert.match(fetcher, /overallSignal.*addEventListener\('abort'/, 'fetchStremioStreamResponse consumes the aggregate signal (pre-existing, now actually fed)');
ok(true, '5. static wiring: aggregate signal reaches the outbound fetch; pool is bounded');

console.log(`phase1_downloader_timeout_test: ${passed} checks passed (aggregate timeout propagates + bounded concurrency)`);
