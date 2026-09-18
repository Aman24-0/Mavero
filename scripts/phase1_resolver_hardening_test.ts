import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveWithBoundedFallback, DEFAULT_FALLBACK_MAX_ATTEMPTS } from '$lib/server/resolver/fallback';
import { createResolutionDeadline, RESOLVER_OVERALL_DEADLINE_MS } from '$lib/server/resolver/deadline';
import { ResolverError } from '$lib/server/resolver/errors';
import { createBoundedHealthScheduler, HEALTH_FLUSH_BUDGET_MS } from '$lib/server/streaming/health-service';
import { createMockAdapter } from '$lib/server/resolver/adapters';
import type { NormalizedMediaItem } from '$lib/server/content/types';
import type { ResolverDependencies, ResolverRequest, TrustedResolutionConfig } from '$lib/server/resolver/types';

/**
 * Phase 1 (audit BL-6 / PRV-01 / PRV-09) — resolver hardening.
 *
 * P0-5  BOUND RESOLVER FALLBACK — the service passed
 *       `maxAttempts: candidates.length` (up to ~200 sources) so the
 *       DEFAULT_FALLBACK_MAX_ATTEMPTS=3 cap was dead code; one public
 *       resolve could fan out to hundreds of sequential attempts.
 *       Fix: the fallback default IS the small cap, and the production
 *       service passes it explicitly. Manual explicit source selection is
 *       untouched (it never enters the fallback loop).
 *
 * P0-6  HEALTH OFF THE CRITICAL PATH — every fallback attempt used to
 *       AWAIT two health DB round-trips before the next attempt. Fix: the
 *       bounded scheduler issues writes without blocking the resolver loop
 *       and flushes them under a hard budget (durable, bounded, no
 *       unhandled rejections, no unbounded queue).
 *
 * P0-7  RESOLVER OVERALL DEADLINE — one typed deadline
 *       (RESOLUTION_TIMEOUT, 504) racing every expensive phase; stale
 *       operations are drained and can never overwrite later results.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const content: NormalizedMediaItem = {
  id: 'movie-8633518', title: 'Afterlight', year: 2024, type: 'movie', runtime: '2h 08m', rating: 8.4, genres: ['Drama'], description: 'Fixture', poster: 'https://images.example.test/poster.jpg', backdrop: 'https://images.example.test/backdrop.jpg', accent: '#9b87f5', source: { provider: 'tmdb', externalId: '8633518', fetchedAt: new Date().toISOString() }, externalIds: { tmdb: '8633518', imdb: 'tt8633518' },
} as unknown as NormalizedMediaItem;

const request: ResolverRequest = { sourceId: 'source-a', contentId: content.id, mediaType: 'movie' };

function config(providerId: string, sourceId: string, adapterId: string): TrustedResolutionConfig {
  return {
    provider: { id: providerId, name: providerId, status: 'active', enabled: true, integration_type: 'direct', adapter_id: adapterId, capabilities: { movie: true } },
    source: { id: sourceId, provider_id: providerId, name: sourceId, status: 'active', enabled: true, visibility: 'public', integration_type: 'direct', capabilities: { movie: true }, movie_template: 'https://media.example.test/{tmdb_id}.m3u8', series_template: null, anime_template: null, identifier_mode: 'tmdb_id', audio_languages: ['English'], subtitle_capability: false, quality_capability: [] },
  } as unknown as TrustedResolutionConfig;
}

function directResult(sourceId: string) {
  return { type: 'direct' as const, url: `https://media.example.test/${sourceId}.m3u8` };
}

// ============================================================
// P0-5 — automatic fallback is genuinely bounded
// ============================================================

{
  const attempted: string[] = [];
  const candidates = Array.from({ length: 12 }, (_, index) =>
    index === 11
      ? { config: config('p-win', 's-win', 'win') }
      : { config: config(`p-${index}`, `s-${index}`, 'fail') },
  );
  const dependencies = {
    adaptersById: {
      fail: createMockAdapter('direct', null),
      win: createMockAdapter('direct', directResult('s-win')),
    },
  } as never;
  // NO maxAttempts passed — the DEFAULT cap must apply (this mirrors the
  // production wiring).
  await assert.rejects(
    () => resolveWithBoundedFallback(request, content, candidates, dependencies, { onFailure: (candidate) => attempted.push(candidate.config.source.id) }),
    (error: unknown) => error instanceof ResolverError && error.code === 'RESOLUTION_UNAVAILABLE',
    'automatic fallback with an exhausted candidate list throws the typed unavailable error',
  );
  assert.equal(attempted.length, DEFAULT_FALLBACK_MAX_ATTEMPTS, `the default cap (${DEFAULT_FALLBACK_MAX_ATTEMPTS}) limits REAL attempts`);
  assert.equal(attempted.includes('s-win'), false, 'the winning candidate far behind the cap is never reached (budget enforced)');
  assert.deepEqual(attempted, ['s-0', 's-1', 's-2'], 'attempt order stays deterministic (ranked order)');
  ok(true, `P0-5a. automatic fallback is capped at DEFAULT_FALLBACK_MAX_ATTEMPTS=${DEFAULT_FALLBACK_MAX_ATTEMPTS} (was: candidate count)`);
}

// Skipped candidates do not consume the attempt budget: with maxAttempts=2,
// (fail, skip-duplicate-provider, win) resolves SUCCESSFULLY — the skip
// between the two real attempts leaves budget for the winner.
{
  let realFailures = 0;
  let skips = 0;
  const candidates = [
    { config: config('p-a', 's-a', 'fail') },
    { config: config('p-a', 's-a-dup', 'win') }, // duplicate provider -> skipped
    { config: config('p-b', 's-b', 'win') },
  ];
  const dependencies: ResolverDependencies = {
    adaptersById: {
      fail: createMockAdapter('direct', null),
      win: createMockAdapter('direct', directResult('s-b')),
    },
  };
  const result = await resolveWithBoundedFallback(request, content, candidates, dependencies, {
    maxAttempts: 2,
    avoidDuplicateProviders: true,
    onFailure: () => {
      realFailures += 1;
    },
  });
  assert.equal(result.result.sourceId, 's-b', 'duplicate-provider candidate is skipped, next provider still wins within the cap');
  assert.equal(realFailures, 1, 'exactly one real failed attempt');
  assert.equal(result.attempts.filter((attempt) => attempt.result === 'skipped').length, 1, 'the duplicate-provider candidate was skipped, not attempted');
  ok(true, 'P0-5b. deterministic ordering + duplicate-provider skip semantics preserved (skips do not consume the budget)');
}

// Explicit source selection (allowFallback: false) is NOT capped/redirected.
{
  const candidates = [
    { config: config('p-explicit', 's-explicit', 'win') },
    { config: config('p-other', 's-other', 'win') },
  ];
  const dependencies = {
    adaptersById: { win: createMockAdapter('direct', directResult('s-explicit')) },
  } as never;
  const result = await resolveWithBoundedFallback({ ...request, allowFallback: false }, content, candidates, dependencies, {
    allowFallback: false,
  });
  assert.equal(result.result.sourceId, 's-explicit', 'manual selection resolves EXACTLY the requested source');
  assert.equal(result.attempts.length, 1, 'manual selection performs exactly one attempt (no fallback to s-other)');
  ok(true, 'P0-5c. explicit source selection remains deterministic and uncapped in intent');
}

// ============================================================
// P0-6 — health bookkeeping off the critical path
// ============================================================

{
  // A pathological DB: every health call takes 400ms. The OLD code awaited
  // these INSIDE the fallback loop (2 round-trips per attempt). The
  // scheduler issues them without blocking, so a capped 3-attempt
  // resolution with per-attempt work of ~1ms completes far below the
  // awaited-DB cost.
  const dbCalls: string[] = [];
  const slowClient = {
    from(table: string) {
      assert.equal(table, 'streaming_provider_health');
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    limit() {
                      return {
                        maybeSingle: () => new Promise<{ data: null; error: null }>((resolve) => setTimeout(() => resolve({ data: null, error: null }), 400)),
                      };
                    },
                  };
                },
              };
            },
          };
        },
        upsert() {
          dbCalls.push('upsert');
          return new Promise<{ error: null }>((resolve) => setTimeout(() => resolve({ error: null }), 400));
        },
      };
    },
  } as never;

  const scheduler = createBoundedHealthScheduler(slowClient);
  const started = Date.now();
  scheduler.recordSuccess('p1', 's1');
  scheduler.recordFailure('p1', 's2', new ResolverError('RESOLUTION_UNAVAILABLE'));
  const recorded = Date.now() - started;
  assert.ok(recorded < 100, `record*() must not block the caller (took ${recorded}ms, awaited DB would need ~800ms+)`);

  // Writes were ISSUED (durable, not fire-and-forget)...
  await scheduler.flush();
  assert.equal(dbCalls.length, 2, 'both health writes were issued through the real record* functions');
  // ...and the flush budget is bounded.
  const hungClient = {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ limit: () => ({ maybeSingle: () => new Promise<never>(() => {}) }) }) }) }),
      upsert: () => new Promise<never>(() => {}),
    }),
  } as never;
  const hungScheduler = createBoundedHealthScheduler(hungClient, 40);
  hungScheduler.recordSuccess('p', 's');
  const flushStarted = Date.now();
  await hungScheduler.flush();
  const flushed = Date.now() - flushStarted;
  assert.ok(flushed < 400, `flush is bounded by the budget (took ${flushed}ms)`);
  ok(true, `P0-6a. health writes start non-blocking and flush under a hard budget (HEALTH_FLUSH_BUDGET_MS=${HEALTH_FLUSH_BUDGET_MS})`);

  // A pathological DB that REJECTS must not produce unhandled rejections —
  // the record* functions catch internally; flush (allSettled) drains.
  let unhandled = 0;
  const onUnhandled = () => {
    unhandled += 1;
  };
  process.on('unhandledRejection', onUnhandled);
  const rejectingClient = {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ limit: () => ({ maybeSingle: () => Promise.reject(new Error('db down')) }) }) }) }),
      upsert: () => Promise.reject(new Error('db down')),
    }),
  } as never;
  const rejectingScheduler = createBoundedHealthScheduler(rejectingClient);
  rejectingScheduler.recordSuccess('p', 's');
  rejectingScheduler.recordFailure('p', 's', new ResolverError('RESOLUTION_UNAVAILABLE'));
  await rejectingScheduler.flush();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(unhandled, 0, 'no unhandled rejections from failing health writes');
  process.off('unhandledRejection', onUnhandled);
  ok(true, 'P0-6b. failing health writes never become unhandled rejections and are logged, not silently lost');

  // Flush with no pending work resolves immediately.
  await createBoundedHealthScheduler(slowClient).flush();
  ok(true, 'P0-6c. empty flush is a no-op');
}

// Production wiring: the resolver loop receives NON-async (enqueue-only)
// callbacks and flushes once at the end.
{
  const service = read('src/lib/server/resolver/service.ts');
  assert.match(service, /maxAttempts: DEFAULT_FALLBACK_MAX_ATTEMPTS/, 'production passes the bounded cap (no longer candidates.length)');
  assert.doesNotMatch(service, /maxAttempts: candidates\.length/, 'the unbounded candidates.length budget is gone');
  assert.match(service, /health\.recordSuccess\(candidate\.config\.provider\.id, candidate\.config\.source\.id\)/, 'fallback onSuccess issues non-blocking writes');
  assert.match(service, /await health\?\.flush\(\);/, 'the scheduler is flushed before the resolution settles');
  ok(true, 'P0-6d. production resolveSource wiring: capped loop + non-blocking scheduler + bounded flush');
}

// ============================================================
// P0-7 — the overall resolver deadline
// ============================================================

// Fast work passes through with its value.
{
  const deadline = createResolutionDeadline(200);
  const value = await deadline.guard(Promise.resolve('fast'));
  assert.equal(value, 'fast');
  deadline.dispose();
  ok(true, 'P0-7a. deadline passes fast work through with its value');
}

// Slow work loses the race and the typed error is produced quickly.
{
  const deadline = createResolutionDeadline(40);
  const started = Date.now();
  await assert.rejects(
    () => deadline.guard(new Promise<string>((resolve) => setTimeout(() => resolve('too late'), 2000))),
    (error: unknown) => {
      assert.ok(error instanceof ResolverError, 'the deadline error is the TYPED ResolverError');
      assert.equal((error as ResolverError).code, 'RESOLUTION_TIMEOUT');
      assert.equal((error as ResolverError).status, 504, 'RESOLUTION_TIMEOUT maps to HTTP 504');
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `the deadline fired early (took ${elapsed}ms, the work needed 2000ms)`);
  assert.equal(deadline.expired, true, 'the deadline reports expiry');
  deadline.dispose();
  ok(true, 'P0-7b. expiry produces the typed RESOLUTION_TIMEOUT (504), never a generic exception');
}

// Stale operations are drained: a LATE REJECTION after the deadline can
// never become an unhandled rejection.
{
  let unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  const deadline = createResolutionDeadline(30);
  const stale = new Promise<string>((_, reject) => setTimeout(() => reject(new Error('stale op failed')), 80));
  await deadline.guard(stale).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(unhandled.length, 0, 'the stale rejection was drained');
  process.off('unhandledRejection', onUnhandled);
  deadline.dispose();
  ok(true, 'P0-7c. stale/aborted operations are drained — no unhandled rejections');
}

// Stale operations can never OVERWRITE later results: the guard contract
// returns exactly ONE outcome — the deadline error — and the late value is
// discarded.
{
  const deadline = createResolutionDeadline(30);
  let lateValueObserved = false;
  await deadline
    .guard(new Promise<string>((resolve) => setTimeout(() => resolve('STALE RESULT'), 80)))
    .then(() => {
      lateValueObserved = true;
    })
    .catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(lateValueObserved, false, 'the late value is never delivered through the guard');
  deadline.dispose();
  ok(true, 'P0-7d. stale results cannot overwrite later source results');
}

// throwIfExpired after expiry throws the typed error; dispose stops the timer.
{
  const deadline = createResolutionDeadline(20);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.throws(() => deadline.throwIfExpired(), (error: unknown) => error instanceof ResolverError && error.code === 'RESOLUTION_TIMEOUT');
  deadline.dispose();
  ok(true, 'P0-7e. throwIfExpired is the typed between-attempts checkpoint');
}

// The default deadline constant is a small, sane budget.
{
  assert.equal(typeof RESOLVER_OVERALL_DEADLINE_MS, 'number');
  assert.ok(RESOLVER_OVERALL_DEADLINE_MS >= 10_000 && RESOLVER_OVERALL_DEADLINE_MS <= 30_000, 'the overall deadline is a bounded production budget');
  ok(true, `P0-7f. default overall deadline is ${RESOLVER_OVERALL_DEADLINE_MS}ms (complements per-operation timeouts)`);
}

// Between-attempt abort: a deadline-aware isEligible aborts the loop with
// the TYPED error (not wrapped into RESOLUTION_UNAVAILABLE).
{
  const deadline = createResolutionDeadline(10);
  await new Promise((resolve) => setTimeout(resolve, 30)); // the overall budget expires
  assert.equal(deadline.expired, true);
  const candidates = [
    { config: config('p-1', 's-1', 'fail') },
    { config: config('p-2', 's-2', 'fail') },
    { config: config('p-3', 's-3', 'fail') },
  ];
  const dependencies: ResolverDependencies = { adaptersById: { fail: createMockAdapter('direct', null) } };
  await assert.rejects(
    () =>
      resolveWithBoundedFallback(request, content, candidates, dependencies, {
        maxAttempts: 3,
        isEligible: async () => {
          // The production wiring calls this checkpoint before EVERY attempt.
          deadline.throwIfExpired();
          return true;
        },
      }),
    (error: unknown) => error instanceof ResolverError && error.code === 'RESOLUTION_TIMEOUT',
    'a typed deadline error thrown between attempts propagates unwrapped (no attempt masking it into RESOLUTION_UNAVAILABLE)',
  );
  deadline.dispose();
  ok(true, 'P0-7g. no further attempt starts once the deadline expires (typed abort between attempts)');
}

// Production wiring: ONE deadline around the whole resolution.
{
  const service = read('src/lib/server/resolver/service.ts');
  assert.match(service, /const deadline = createResolutionDeadline\(dependencies\.deadlineMs \?\? RESOLVER_OVERALL_DEADLINE_MS\)/, 'resolveSource creates ONE overall deadline');
  assert.match(service, /deadline\.guard\(/, 'expensive phases are raced against the deadline');
  assert.match(service, /deadline\.throwIfExpired\(\);\s*\n\s*return candidate\.eligible !== false;/, 'the fallback loop checks the deadline between attempts');
  assert.match(service, /finally \{\s*\n\s*deadline\.dispose\(\);/, 'the deadline timer is always disposed');
  const errors = read('src/lib/server/resolver/errors.ts');
  assert.match(errors, /RESOLUTION_TIMEOUT: 504/, 'the typed timeout maps to HTTP 504');
  const prodEndpoint = read('src/routes/api/playback/resolve/+server.ts');
  assert.match(prodEndpoint, /asResolverError/, 'the endpoint normalizes the typed timeout through the existing error convention');
  ok(true, 'P0-7h. production wiring: single deadline, typed error, endpoint convention preserved');
}

console.log(`phase1_resolver_hardening_test: ${passed} checks passed (fallback cap + health off critical path + overall deadline)`);
