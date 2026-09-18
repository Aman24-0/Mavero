import assert from 'node:assert/strict';
import { cacheStats, clearCache, getOrSet, invalidate, __test } from '../src/lib/server/content/cache';

/**
 * Phase 2-D (audit PERF-004 / MEM-001) — Bound in-process content cache.
 *
 * Problem: the previous implementation used an unbounded `Map`. Cache keys
 * are derived from request params (section, language, provider, page,
 * type, id, sort, cursor, ...). Under sustained traffic against varied
 * filter combinations, the cache grew without limit, holding server
 * memory indefinitely. Expired entries were never reaped.
 *
 * Fix: small LRU bound (256) + amortized expiry sweep (1 min interval).
 *
 * Required properties (audit Phase 2-D):
 *   - maximum entry count (DEFAULT_MAX_ENTRIES)
 *   - expiration cleanup (stale entries don't survive past staleUntil)
 *   - stale-entry cleanup (amortized sweep reaps expired entries)
 *   - protection against unlimited key cardinality (LRU eviction)
 *   - preservation of stale-while-revalidate behavior
 *   - preservation of request de-duplication / in-flight behavior
 *   - cacheStats() remains useful
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

async function run() {
  clearCache();

  // ============================================================
  // 1. Basic getOrSet — first call loads, second serves from cache.
  // ============================================================
  let loadCount = 0;
  const loader = async () => {
    loadCount += 1;
    return { value: loadCount };
  };
  const first = await getOrSet('k1', { ttlMs: 1000, staleWhileRevalidateMs: 2000 }, loader);
  const second = await getOrSet('k1', { ttlMs: 1000, staleWhileRevalidateMs: 2000 }, loader);
  ok(first.value.value === 1 && second.value.value === 1, '1a. first call loads, second serves from cache');
  ok(loadCount === 1, '1b. loader invoked exactly once (cache hit)');
  ok(first.stale === false && second.stale === false, '1c. fresh entries report stale:false');

  // ============================================================
  // 2. LRU eviction — over-capacity evicts oldest insertion-order key.
  // ============================================================
  clearCache();
  const max = __test.DEFAULT_MAX_ENTRIES;
  // Fill exactly to capacity.
  for (let i = 0; i < max; i++) {
    await getOrSet(`key-${i}`, { ttlMs: 60_000 }, async () => i);
  }
  const atCapacity = cacheStats();
  ok(atCapacity.entries === max, `2a. cache holds exactly ${max} entries at capacity (got ${atCapacity.entries})`);
  ok(atCapacity.evictions === 0, '2b. no evictions at exactly capacity');

  // Add one more — should evict the oldest (key-0).
  await getOrSet(`key-${max}`, { ttlMs: 60_000 }, async () => max);
  const overCapacity = cacheStats();
  ok(overCapacity.entries === max, `2c. cache still holds ${max} entries after overflow (LRU evicted the oldest)`);
  ok(overCapacity.evictions === 1, `2d. one eviction recorded (got ${overCapacity.evictions})`);

  // The oldest entry (key-0) should be gone — re-fetching it triggers a new load.
  let reloadCount = 0;
  const reloaded = await getOrSet('key-0', { ttlMs: 60_000 }, async () => { reloadCount += 1; return 'reloaded'; });
  ok(reloaded.value === 'reloaded' && reloadCount === 1, '2e. evicted key-0 triggered a fresh load (was LRU-evicted)');

  // Re-inserting key-0 overflows the cache again — the new oldest (key-1) is
  // evicted to make room. key-2 (still cached) must NOT trigger a load.
  let shouldNotLoad = 0;
  const cached = await getOrSet('key-2', { ttlMs: 60_000 }, async () => { shouldNotLoad += 1; return 'should-not-happen'; });
  ok(cached.value === 2 && shouldNotLoad === 0, '2f. non-evicted key-2 served from cache (no reload)');

  // ============================================================
  // 3. LRU recency — reading a key refreshes its LRU position.
  // ============================================================
  clearCache();
  // Fill to capacity.
  for (let i = 0; i < max; i++) {
    await getOrSet(`k-${i}`, { ttlMs: 60_000 }, async () => i);
  }
  // Touch k-0 — it should now be the most-recently-used, NOT evicted next.
  await getOrSet('k-0', { ttlMs: 60_000 }, async () => 'should-not-load');
  // Add a new key — should evict k-1 (the oldest now), NOT k-0.
  await getOrSet('k-new', { ttlMs: 60_000 }, async () => 'new');
  let k0Reloads = 0;
  const k0StillCached = await getOrSet('k-0', { ttlMs: 60_000 }, async () => { k0Reloads += 1; return 'reloaded'; });
  ok(k0StillCached.value === 0 && k0Reloads === 0, '3a. recently-read k-0 survived LRU eviction (was promoted)');

  // ============================================================
  // 4. Expiry — entries past expiresAt trigger a fresh load.
  // ============================================================
  clearCache();
  await getOrSet('expiring', { ttlMs: 10, staleWhileRevalidateMs: 0 }, async () => 'first');
  // Wait past TTL.
  await new Promise((resolve) => setTimeout(resolve, 30));
  let expiryLoadCount = 0;
  const expiredResult = await getOrSet('expiring', { ttlMs: 10, staleWhileRevalidateMs: 0 }, async () => { expiryLoadCount += 1; return 'second'; });
  ok(expiredResult.value === 'second' && expiryLoadCount === 1, '4a. expired entry triggered a fresh load');
  ok(expiredResult.stale === false, '4b. fresh load reports stale:false');

  // ============================================================
  // 5. Stale-while-revalidate — past expiresAt but within staleUntil
  //    returns stale value immediately + triggers background refresh.
  // ============================================================
  clearCache();
  await getOrSet('swr', { ttlMs: 10, staleWhileRevalidateMs: 5000 }, async () => 'fresh');
  await new Promise((resolve) => setTimeout(resolve, 30)); // past TTL, within stale window
  let swrLoadCount = 0;
  const swrResult = await getOrSet('swr', { ttlMs: 10, staleWhileRevalidateMs: 5000 }, async () => { swrLoadCount += 1; return 'refreshed'; });
  ok(swrResult.value === 'fresh' && swrResult.stale === true, '5a. stale entry returned immediately (SWR)');
  // Background refresh runs — wait for it.
  await new Promise((resolve) => setTimeout(resolve, 10));
  ok(swrLoadCount === 1, '5b. background refresh ran exactly once');

  // ============================================================
  // 6. Stale window expired — entry is reaped on read.
  // ============================================================
  clearCache();
  await getOrSet('dead', { ttlMs: 10, staleWhileRevalidateMs: 10 }, async () => 'first');
  await new Promise((resolve) => setTimeout(resolve, 50)); // past staleUntil
  let deadLoadCount = 0;
  const deadResult = await getOrSet('dead', { ttlMs: 10, staleWhileRevalidateMs: 10 }, async () => { deadLoadCount += 1; return 'second'; });
  ok(deadResult.value === 'second' && deadLoadCount === 1, '6a. past-staleUntil entry triggered a fresh load');
  ok(cacheStats().expiredReaped >= 1, '6b. expired entry reaped and counted');

  // ============================================================
  // 7. Amortized sweep — expired entries are reaped even without reads.
  // ============================================================
  clearCache();
  __test.forceSweepOnNextRead(); // make the next read trigger a sweep
  // Seed an entry that will expire soon.
  __test.seedEntry('sweep-target', 'value', { ttlMs: 10, staleWhileRevalidateMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 50)); // past staleUntil
  // Trigger a read on a DIFFERENT key — the sweep should run and reap the expired entry.
  await getOrSet('trigger-sweep', { ttlMs: 60_000 }, async () => 'trigger');
  const peeked = __test.peekEntry('sweep-target');
  ok(peeked === undefined, '7a. sweep reaped the expired entry (no manual read on that key)');
  ok(cacheStats().sweeps >= 1, '7b. sweep ran at least once');

  // ============================================================
  // 8. Concurrent same-key requests — single-flight de-duplication.
  // ============================================================
  clearCache();
  let concurrentLoadCount = 0;
  // Three concurrent calls with the same key — loader should run ONCE.
  const concurrent = await Promise.all([
    getOrSet('concurrent', { ttlMs: 60_000 }, async () => { concurrentLoadCount += 1; await new Promise((r) => setTimeout(r, 20)); return 'result'; }),
    getOrSet('concurrent', { ttlMs: 60_000 }, async () => { concurrentLoadCount += 1; return 'should-not-load'; }),
    getOrSet('concurrent', { ttlMs: 60_000 }, async () => { concurrentLoadCount += 1; return 'should-not-load'; })
  ]);
  ok(concurrent[0].value === 'result' && concurrent[1].value === 'result' && concurrent[2].value === 'result', '8a. concurrent same-key requests all received the same value');
  ok(concurrentLoadCount === 1, `8b. loader ran exactly once for concurrent same-key requests (got ${concurrentLoadCount})`);
  ok(cacheStats().requestsInFlight === 0, '8c. in-flight entry cleared after completion');

  // ============================================================
  // 9. invalidate(prefix) — removes matching entries only.
  // ============================================================
  clearCache();
  await getOrSet('movies:popular:1', { ttlMs: 60_000 }, async () => 'a');
  await getOrSet('movies:popular:2', { ttlMs: 60_000 }, async () => 'b');
  await getOrSet('series:popular:1', { ttlMs: 60_000 }, async () => 'c');
  invalidate('movies:popular:');
  let moviesReloads = 0;
  let seriesReloads = 0;
  await getOrSet('movies:popular:1', { ttlMs: 60_000 }, async () => { moviesReloads += 1; return 'reloaded'; });
  await getOrSet('series:popular:1', { ttlMs: 60_000 }, async () => { seriesReloads += 1; return 'reloaded'; });
  ok(moviesReloads === 1, '9a. invalidate(prefix) removed matching movies: entries');
  ok(seriesReloads === 0, '9b. invalidate(prefix) left non-matching series: entries intact');

  // ============================================================
  // 10. cacheStats() remains useful — reports the right shape.
  // ============================================================
  clearCache();
  await getOrSet('stats-test', { ttlMs: 60_000 }, async () => 'value');
  const stats = cacheStats();
  ok(typeof stats.entries === 'number' && stats.entries >= 1, '10a. cacheStats().entries is a positive number');
  ok(typeof stats.requestsInFlight === 'number', '10b. cacheStats().requestsInFlight is a number');
  ok(typeof stats.evictions === 'number', '10c. cacheStats().evictions is a number (new field)');
  ok(typeof stats.sweeps === 'number', '10d. cacheStats().sweeps is a number (new field)');
  ok(typeof stats.expiredReaped === 'number', '10e. cacheStats().expiredReaped is a number (new field)');
  ok(typeof stats.maxEntries === 'number' && stats.maxEntries === __test.DEFAULT_MAX_ENTRIES, '10f. cacheStats().maxEntries matches the configured bound');

  // ============================================================
  // 11. Bound is finite — DEFAULT_MAX_ENTRIES is a sane number.
  // ============================================================
  ok(__test.DEFAULT_MAX_ENTRIES > 0 && __test.DEFAULT_MAX_ENTRIES <= 1024, `11a. DEFAULT_MAX_ENTRIES is a sane bound (got ${__test.DEFAULT_MAX_ENTRIES})`);
  ok(__test.SWEEP_INTERVAL_MS > 0 && __test.SWEEP_INTERVAL_MS <= 5 * 60_000, `11b. SWEEP_INTERVAL_MS is a sane interval (got ${__test.SWEEP_INTERVAL_MS})`);

  console.log(`phase2_content_cache_test: ${passed} checks passed (Phase 2-D bounded LRU cache)`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
