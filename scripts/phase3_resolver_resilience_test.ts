import assert from 'node:assert/strict';
import {
  clearNegativeCache,
  configureNegativeCache,
  getCachedNegative,
  invalidate as invalidateNeg,
  isCacheableNegative,
  negativeCacheKey,
  negativeCacheStats,
  setCachedNegative,
  __test as negTest
} from '../src/lib/server/resolver/negative-cache';
import {
  clearProviderCooldowns,
  isProviderEligible,
  isProbeDue,
  isTransientFailure,
  providerCooldownStats,
  recordProviderFailure,
  recordProviderSuccess,
  __test as cdTest
} from '../src/lib/server/resolver/provider-cooldown';

/**
 * Phase 3-D (audit OBS-4) — Resolver / provider resilience.
 *
 * Behavioral tests for the negative cache + provider cooldown.
 *
 *   1. NEGATIVE CACHE: deterministic outcomes (RESOLUTION_UNAVAILABLE,
 *      UNSUPPORTED_MEDIA_TYPE, MISSING_IDENTIFIER) are cached for a
 *      short TTL; transient failures (TIMEOUT, INTERNAL_ERROR) are
 *      NEVER cached.
 *   2. PROVIDER COOLDOWN: a provider that accumulates CONSECUTIVE
 *      transient failures beyond the threshold is cooled down. A
 *      successful probe recovers it. Deterministic failures do NOT
 *      count toward the cooldown.
 *   3. BOUNDED STATE: the negative cache is LRU-bounded; the cooldown
 *      auto-expires.
 *   4. NO CROSS-USER POISONING: the cooldown is keyed by provider id
 *      only — one user's failures affect all users on the same
 *      instance, but recovery is automatic.
 *   5. PROCESS-LOCAL: documented limitation — no cross-instance
 *      coordination (would require Redis, out of scope).
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

// ============================================================
// 1. Negative cache — isCacheableNegative classification.
// ============================================================
ok(isCacheableNegative('RESOLUTION_UNAVAILABLE') === true, '1a. RESOLUTION_UNAVAILABLE is cacheable (deterministic)');
ok(isCacheableNegative('UNSUPPORTED_MEDIA_TYPE') === true, '1b. UNSUPPORTED_MEDIA_TYPE is cacheable (deterministic)');
ok(isCacheableNegative('MISSING_IDENTIFIER') === true, '1c. MISSING_IDENTIFIER is cacheable (deterministic)');
// Transient failures are NEVER cached.
ok(isCacheableNegative('RESOLUTION_TIMEOUT') === false, '1d. RESOLUTION_TIMEOUT NOT cacheable (transient)');
ok(isCacheableNegative('INTERNAL_RESOLUTION_ERROR') === false, '1e. INTERNAL_RESOLUTION_ERROR NOT cacheable (transient)');
ok(isCacheableNegative('PROVIDER_RESPONSE_INVALID') === false, '1f. PROVIDER_RESPONSE_INVALID NOT cacheable (transient)');
ok(isCacheableNegative('INVALID_SOURCE_URL') === false, '1g. INVALID_SOURCE_URL NOT cacheable (transient)');

// ============================================================
// 2. Negative cache — store + read.
// ============================================================
clearNegativeCache();
const key = negativeCacheKey({ sourceId: 'src-1', contentId: 'movie-123', mediaType: 'movie' });
ok(typeof key === 'string' && key.startsWith('neg:src-1:movie-123:movie:0:0'), `2a. cache key shape (got ${key})`);

setCachedNegative(key, 'RESOLUTION_UNAVAILABLE', 503);
const cached = getCachedNegative(key);
ok(cached !== undefined, '2b. cached entry is readable');
ok(cached!.code === 'RESOLUTION_UNAVAILABLE', '2c. cached code preserved');
ok(cached!.status === 503, '2d. cached status preserved');
ok(cached!.expiresAt > Date.now(), '2e. cached entry not yet expired');

// ============================================================
// 3. Negative cache — TTL expiration.
// ============================================================
clearNegativeCache();
configureNegativeCache({ ttlMs: 10 });
setCachedNegative(key, 'RESOLUTION_UNAVAILABLE', 503);
await new Promise((r) => setTimeout(r, 30));
const expired = getCachedNegative(key);
ok(expired === undefined, '3a. expired entry is not served');
configureNegativeCache({ ttlMs: 60_000 }); // reset
negTest.resetDefaults();

// ============================================================
// 4. Negative cache — transient failures are NEVER stored.
// ============================================================
clearNegativeCache();
setCachedNegative(key, 'RESOLUTION_TIMEOUT', 504); // transient — should be a no-op
ok(getCachedNegative(key) === undefined, '4a. transient failure (TIMEOUT) NOT stored as a negative');
setCachedNegative(key, 'INTERNAL_RESOLUTION_ERROR', 500); // transient
ok(getCachedNegative(key) === undefined, '4b. transient failure (INTERNAL) NOT stored as a negative');
setCachedNegative(key, 'RESOLUTION_UNAVAILABLE', 503); // deterministic — should store
ok(getCachedNegative(key) !== undefined, '4c. deterministic failure (UNAVAILABLE) IS stored');

// ============================================================
// 5. Negative cache — LRU bound.
// ============================================================
clearNegativeCache();
configureNegativeCache({ maxEntries: 4 });
for (let i = 0; i < 4; i++) {
  setCachedNegative(`neg:src-${i}:c:movie:0:0`, 'RESOLUTION_UNAVAILABLE', 503);
}
ok(negativeCacheStats().entries === 4, `5a. cache holds 4 entries at capacity (got ${negativeCacheStats().entries})`);
setCachedNegative('neg:src-overflow:c:movie:0:0', 'RESOLUTION_UNAVAILABLE', 503);
ok(negativeCacheStats().entries === 4, `5b. cache still holds 4 entries after overflow (LRU evicted oldest)`);
ok(getCachedNegative('neg:src-0:c:movie:0:0') === undefined, '5c. LRU evicted the oldest entry (src-0)');
configureNegativeCache({ maxEntries: 256 }); // reset
negTest.resetDefaults();

// ============================================================
// 6. Negative cache — invalidate by sourceId.
// ============================================================
clearNegativeCache();
setCachedNegative('neg:src-A:content-1:movie:0:0', 'RESOLUTION_UNAVAILABLE', 503);
setCachedNegative('neg:src-A:content-2:movie:0:0', 'RESOLUTION_UNAVAILABLE', 503);
setCachedNegative('neg:src-B:content-1:movie:0:0', 'RESOLUTION_UNAVAILABLE', 503);
invalidateNeg('src-A');
ok(getCachedNegative('neg:src-A:content-1:movie:0:0') === undefined, '6a. invalidate(src-A) removed src-A entries (content-1)');
ok(getCachedNegative('neg:src-A:content-2:movie:0:0') === undefined, '6b. invalidate(src-A) removed src-A entries (content-2)');
ok(getCachedNegative('neg:src-B:content-1:movie:0:0') !== undefined, '6c. invalidate(src-A) left src-B entries intact');

// ============================================================
// 7. Provider cooldown — isTransientFailure classification.
// ============================================================
ok(isTransientFailure('RESOLUTION_TIMEOUT') === true, '7a. RESOLUTION_TIMEOUT is transient');
ok(isTransientFailure('INTERNAL_RESOLUTION_ERROR') === true, '7b. INTERNAL_RESOLUTION_ERROR is transient');
ok(isTransientFailure('INVALID_SOURCE_URL') === true, '7c. INVALID_SOURCE_URL is transient');
ok(isTransientFailure('INVALID_PROVIDER_ENDPOINT') === true, '7d. INVALID_PROVIDER_ENDPOINT is transient');
ok(isTransientFailure('PROVIDER_RESPONSE_INVALID') === true, '7e. PROVIDER_RESPONSE_INVALID is transient');
// Deterministic outcomes are NOT transient.
ok(isTransientFailure('RESOLUTION_UNAVAILABLE') === false, '7f. RESOLUTION_UNAVAILABLE NOT transient (deterministic)');
ok(isTransientFailure('UNSUPPORTED_MEDIA_TYPE') === false, '7g. UNSUPPORTED_MEDIA_TYPE NOT transient (deterministic)');
ok(isTransientFailure('PROVIDER_DISABLED') === false, '7h. PROVIDER_DISABLED NOT transient (admin state, not failure)');

// ============================================================
// 8. Provider cooldown — threshold + cooldown.
// ============================================================
clearProviderCooldowns();
const providerId = 'prov-1';
const threshold = cdTest.FAILURE_THRESHOLD;
// Below threshold: still eligible.
for (let i = 0; i < threshold - 1; i++) {
  recordProviderFailure(providerId, 'RESOLUTION_TIMEOUT');
}
ok(isProviderEligible(providerId) === true, `8a. provider still eligible below threshold (${threshold - 1} failures)`);
// At threshold: cooled down, not eligible.
recordProviderFailure(providerId, 'RESOLUTION_TIMEOUT');
ok(isProviderEligible(providerId) === false, `8b. provider NOT eligible after ${threshold} consecutive transient failures (cooldown started)`);

// ============================================================
// 9. Provider cooldown — probe due during cooldown.
// ============================================================
ok(isProbeDue(providerId) === false, '9a. probe NOT due immediately after cooldown starts (nextProbeAt = cooldownStart + PROBE_INTERVAL)');
// Advance time past PROBE_INTERVAL — probe becomes due.
const future1 = Date.now() + cdTest.PROBE_INTERVAL_MS + 100;
ok(isProbeDue(providerId, future1) === true, '9b. probe due after PROBE_INTERVAL elapses');
// After a probe attempt fails, the next probe is pushed back.
recordProviderFailure(providerId, 'RESOLUTION_TIMEOUT', future1);
ok(isProbeDue(providerId, future1) === false, '9c. probe NOT due immediately after a failed probe (extended)');
// Advance time past PROBE_INTERVAL again.
const future2 = future1 + cdTest.PROBE_INTERVAL_MS + 100;
ok(isProbeDue(providerId, future2) === true, '9d. probe due again after another PROBE_INTERVAL elapses');

// ============================================================
// 10. Provider cooldown — success recovers immediately.
// ============================================================
clearProviderCooldowns();
// Cool down the provider.
for (let i = 0; i < threshold; i++) {
  recordProviderFailure(providerId, 'RESOLUTION_TIMEOUT');
}
ok(isProviderEligible(providerId) === false, '10a. provider cooled down after threshold failures');
// A single success fully recovers.
recordProviderSuccess(providerId);
ok(isProviderEligible(providerId) === true, '10b. single success recovers the provider immediately');
ok(isProbeDue(providerId) === false, '10c. no probe due after recovery (cooldown cleared)');

// ============================================================
// 11. Provider cooldown — deterministic failures do NOT count.
// ============================================================
clearProviderCooldowns();
for (let i = 0; i < threshold * 3; i++) {
  recordProviderFailure(providerId, 'UNSUPPORTED_MEDIA_TYPE'); // deterministic — no-op
}
ok(isProviderEligible(providerId) === true, '11a. deterministic failures do NOT trigger cooldown (still eligible)');
const stats = providerCooldownStats();
ok(stats.providers === 0, `11b. no provider state recorded for deterministic failures (got ${stats.providers} providers)`);

// ============================================================
// 12. Provider cooldown — auto-expiry (worst-case bound).
// ============================================================
clearProviderCooldowns();
for (let i = 0; i < threshold; i++) {
  recordProviderFailure(providerId, 'RESOLUTION_TIMEOUT');
}
ok(isProviderEligible(providerId) === false, '12a. provider cooled down');
// Advance time past COOLDOWN_MS.
const farFuture = Date.now() + cdTest.COOLDOWN_MS + 1000;
// Trigger the auto-expiry check (recordProviderFailure runs the check,
// but isProviderEligible alone does not — so we record another failure
// at the far-future time, which should auto-expire the cooldown).
recordProviderFailure(providerId, 'RESOLUTION_TIMEOUT', farFuture);
ok(isProviderEligible(providerId, farFuture) === true, '12b. cooldown auto-expires after COOLDOWN_MS (worst-case bound)');

// ============================================================
// 13. Provider cooldown — bounded state.
// ============================================================
clearProviderCooldowns();
// Record failures for many providers — the state Map grows with the
// number of DISTINCT provider ids, which is bounded by the provider
// table size (small in practice).
for (let i = 0; i < 10; i++) {
  recordProviderFailure(`prov-${i}`, 'RESOLUTION_TIMEOUT');
}
const boundedStats = providerCooldownStats();
ok(boundedStats.providers === 10, `13a. state tracks 10 distinct providers (got ${boundedStats.providers})`);
ok(boundedStats.threshold === cdTest.FAILURE_THRESHOLD, `13b. threshold documented in stats (${boundedStats.threshold})`);
ok(typeof boundedStats.cooldownMs === 'number' && boundedStats.cooldownMs > 0, '13c. cooldownMs documented in stats');

// ============================================================
// 14. Provider cooldown — no cross-user poisoning (keyed by provider only).
// ============================================================
clearProviderCooldowns();
// Two different "users" — the cooldown is keyed by provider, not user.
for (let i = 0; i < threshold; i++) {
  recordProviderFailure(providerId, 'RESOLUTION_TIMEOUT');
}
// "User B" sees the same cooldown — the provider is cooling down for
// everyone on this instance.
ok(isProviderEligible(providerId) === false, '14a. cooldown is keyed by provider id (affects all users on this instance)');
// Recovery is automatic (probe success), so no permanent poisoning.
recordProviderSuccess(providerId);
ok(isProviderEligible(providerId) === true, '14b. recovery is automatic — no permanent poisoning');

// ============================================================
// 15. Integration — fallback.ts wires both checks.
// (Static source-level contract: verify the imports + call sites.)
// ============================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');
const fallback = read('src/lib/server/resolver/fallback.ts');
ok(/import \{ getCachedNegative, setCachedNegative, negativeCacheKey, isCacheableNegative \} from '\.\/negative-cache'/.test(fallback), '15a. fallback.ts imports the negative cache');
ok(/import \{ isProviderEligible, isProbeDue, recordProviderSuccess, recordProviderFailure, isTransientFailure \} from '\.\/provider-cooldown'/.test(fallback), '15b. fallback.ts imports the provider cooldown');
ok(/getCachedNegative\(negKey\)/.test(fallback), '15c. fallback.ts checks the negative cache before attempting a candidate');
ok(/setCachedNegative\(negKey, resolverError\.code, resolverError\.status\)/.test(fallback), '15d. fallback.ts stores deterministic negatives after a failure');
ok(/isCacheableNegative\(resolverError\.code\)/.test(fallback), '15e. fallback.ts gates negative-cache storage on isCacheableNegative (transient never cached)');
ok(/!isProviderEligible\(candidate\.config\.provider\.id\) && !isProbeDue/.test(fallback), '15f. fallback.ts checks provider cooldown (skip unless probe due)');
ok(/recordProviderSuccess\(candidate\.config\.provider\.id\)/.test(fallback), '15g. fallback.ts records provider success (resets cooldown)');
ok(/isTransientFailure\(resolverError\.code\)/.test(fallback), '15h. fallback.ts gates cooldown recording on isTransientFailure (deterministic never counted)');
ok(/skippedReason\?: 'negative-cache' \| 'provider-cooldown' \| 'ineligible' \| 'duplicate'/.test(fallback), '15i. FallbackAttempt.skippedReason added (audit trail)');

console.log(`phase3_resolver_resilience_test: ${passed} checks passed (Phase 3-D negative cache + provider cooldown)`);
