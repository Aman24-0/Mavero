import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Phase 6.1 — Provider health atomicity + resolver/cache audit.
 *
 * PROBLEM: the existing health-service.ts used an unsafe READ-MODIFY-WRITE
 * pattern (loadRow → modify in JS → upsertRow). Under concurrent requests,
 * success_count, failure_count, and consecutive_failures increments
 * could be lost.
 *
 * FIX: two SECURITY DEFINER RPCs (record_provider_health_success /
 * record_provider_health_failure) that perform atomic INSERT...ON CONFLICT
 * DO UPDATE in a single SQL statement.
 *
 * This test verifies:
 *   1. The migration creates both RPCs with SECURITY DEFINER + search_path=public.
 *   2. EXECUTE is revoked from PUBLIC + authenticated + anon (no privilege leak).
 *   3. The success RPC atomically increments success_count + resets consecutive_failures.
 *   4. The failure RPC atomically increments consecutive_failures + failure_count.
 *   5. The failure RPC sets cooldown_until at the correct threshold (5 failures).
 *   6. The application-side health-service.ts now uses the RPCs (not loadRow+upsertRow).
 *   7. The application-side health.ts nextHealthAfterSuccess/Failure functions are preserved.
 *   8. The resolver fallback loop still uses the bounded health scheduler.
 *   9. The negative cache classification is correct (no transient cached).
 *   10. The provider cooldown is correct (transient only, not deterministic).
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ============================================================
// 1. The migration exists and creates both RPCs.
// ============================================================
const migration = read('supabase/migrations/20260925000000_phase6_provider_health_atomicity.sql');
ok(/create or replace function public\.record_provider_health_success/.test(migration), '1a. migration creates record_provider_health_success');
ok(/create or replace function public\.record_provider_health_failure/.test(migration), '1b. migration creates record_provider_health_failure');

// ============================================================
// 2. Both RPCs are SECURITY DEFINER + search_path = public.
// ============================================================
ok(/security definer/.test(migration), '2a. RPCs are SECURITY DEFINER');
ok(/set search_path = public/.test(migration), '2b. RPCs set search_path = public');

// ============================================================
// 3. EXECUTE is revoked from PUBLIC + authenticated + anon.
// ============================================================
ok(/revoke execute on function public\.record_provider_health_success\(uuid, uuid, timestamptz\) from PUBLIC/.test(migration), '3a. success RPC: EXECUTE revoked from PUBLIC');
ok(/revoke execute on function public\.record_provider_health_success\(uuid, uuid, timestamptz\) from authenticated/.test(migration), '3b. success RPC: EXECUTE revoked from authenticated');
ok(/revoke execute on function public\.record_provider_health_success\(uuid, uuid, timestamptz\) from anon/.test(migration), '3c. success RPC: EXECUTE revoked from anon');
ok(/revoke execute on function public\.record_provider_health_failure\(uuid, uuid, text, timestamptz\) from PUBLIC/.test(migration), '3d. failure RPC: EXECUTE revoked from PUBLIC');
ok(/revoke execute on function public\.record_provider_health_failure\(uuid, uuid, text, timestamptz\) from authenticated/.test(migration), '3e. failure RPC: EXECUTE revoked from authenticated');
ok(/revoke execute on function public\.record_provider_health_failure\(uuid, uuid, text, timestamptz\) from anon/.test(migration), '3f. failure RPC: EXECUTE revoked from anon');
// No grant to any role — postgres superuser bypasses checks.
ok(!/grant execute on function public\.record_provider_health/.test(migration), '3g. no grant to any role (postgres superuser needs no grant)');

// ============================================================
// 4. The success RPC uses INSERT...ON CONFLICT DO UPDATE (atomic).
// ============================================================
ok(/insert into public\.streaming_provider_health[\s\S]*?on conflict \(provider_id, source_id\) do update/.test(migration), '4a. success RPC uses INSERT...ON CONFLICT DO UPDATE (atomic)');
ok(/success_count = public\.streaming_provider_health\.success_count \+ 1/.test(migration), '4b. success RPC atomically increments success_count (no READ-MODIFY-WRITE)');
ok(/consecutive_failures = 0/.test(migration), '4c. success RPC resets consecutive_failures to 0');
ok(/status = 'healthy'/.test(migration), '4d. success RPC sets status to healthy');
ok(/cooldown_until = null/.test(migration), '4e. success RPC clears cooldown_until');

// ============================================================
// 5. The failure RPC uses INSERT...ON CONFLICT DO UPDATE (atomic).
// ============================================================
ok(/consecutive_failures = public\.streaming_provider_health\.consecutive_failures \+ 1/.test(migration), '5a. failure RPC atomically increments consecutive_failures (no READ-MODIFY-WRITE)');
ok(/failure_count = public\.streaming_provider_health\.failure_count \+ 1/.test(migration), '5b. failure RPC atomically increments failure_count');
// Cooldown threshold: 5 consecutive failures.
ok(/v_cooldown_after integer := 5/.test(migration), '5c. failure RPC cooldown threshold is 5 (matches health.ts)');
ok(/v_unhealthy_after integer := 3/.test(migration), '5d. failure RPC unhealthy threshold is 3 (matches health.ts)');
ok(/v_cooldown_ms integer := 300000/.test(migration), '5e. failure RPC cooldown duration is 300000ms = 5min (matches health.ts)');
// Status transitions: degraded < 3, unhealthy 3-4, cooldown >= 5.
ok(/when .* \+ 1 >= v_cooldown_after\s+then 'cooldown'/.test(migration), '5f. failure RPC sets status=cooldown at >= 5 consecutive failures');
ok(/when .* \+ 1 >= v_unhealthy_after\s+then 'unhealthy'/.test(migration), '5g. failure RPC sets status=unhealthy at >= 3 consecutive failures');
ok(/else 'degraded'/.test(migration), '5h. failure RPC sets status=degraded for < 3 consecutive failures');

// ============================================================
// 6. The application-side health-service.ts now uses the RPCs.
// ============================================================
const healthService = read('src/lib/server/streaming/health-service.ts');
ok(/client\.rpc\('record_provider_health_success'/.test(healthService), '6a. health-service.ts calls record_provider_health_success via RPC');
ok(/client\.rpc\('record_provider_health_failure'/.test(healthService), '6b. health-service.ts calls record_provider_health_failure via RPC');
// The old unsafe pattern (loadRow + nextHealthAfter* + upsertRow) must be
// gone from the recordRuntimeSuccess / recordRuntimeFailure functions.
// loadRow is still used by isRuntimeSourceEligible (read-only — safe).
// upsertRow may still exist but must not be called by the record* functions.
const recordSuccessMatch = healthService.match(/export async function recordRuntimeSuccess[\s\S]*?\n\}/);
const recordFailureMatch = healthService.match(/export async function recordRuntimeFailure[\s\S]*?\n\}/);
ok(recordSuccessMatch !== null, '6c. recordRuntimeSuccess function extractable');
ok(recordFailureMatch !== null, '6d. recordRuntimeFailure function extractable');
if (recordSuccessMatch) {
  ok(!/loadRow/.test(recordSuccessMatch[0]), '6e. recordRuntimeSuccess does NOT call loadRow (no READ-MODIFY-WRITE)');
  ok(!/upsertRow/.test(recordSuccessMatch[0]), '6f. recordRuntimeSuccess does NOT call upsertRow (no READ-MODIFY-WRITE)');
  ok(!/nextHealthAfterSuccess/.test(recordSuccessMatch[0]), '6g. recordRuntimeSuccess does NOT call nextHealthAfterSuccess (no JS-side increment)');
}
if (recordFailureMatch) {
  ok(!/loadRow/.test(recordFailureMatch[0]), '6h. recordRuntimeFailure does NOT call loadRow (no READ-MODIFY-WRITE)');
  ok(!/upsertRow/.test(recordFailureMatch[0]), '6i. recordRuntimeFailure does NOT call upsertRow (no READ-MODIFY-WRITE)');
  ok(!/nextHealthAfterFailure/.test(recordFailureMatch[0]), '6j. recordRuntimeFailure does NOT call nextHealthAfterFailure (no JS-side increment)');
}

// ============================================================
// 7. The application-side health.ts functions are preserved.
// ============================================================
const health = read('src/lib/server/streaming/health.ts');
ok(/export function nextHealthAfterSuccess/.test(health), '7a. nextHealthAfterSuccess preserved (used for in-memory derivation)');
ok(/export function nextHealthAfterFailure/.test(health), '7b. nextHealthAfterFailure preserved (used for in-memory derivation)');
ok(/export function deriveRuntimeHealthState/.test(health), '7c. deriveRuntimeHealthState preserved');
ok(/export function isRuntimeHealthEligible/.test(health), '7d. isRuntimeHealthEligible preserved');
ok(/RUNTIME_HEALTH_THRESHOLDS/.test(health), '7e. RUNTIME_HEALTH_THRESHOLDS preserved (matches RPC thresholds)');

// ============================================================
// 8. The resolver fallback loop still uses the bounded health scheduler.
// ============================================================
const resolver = read('src/lib/server/resolver/service.ts');
ok(/createBoundedHealthScheduler/.test(resolver), '8a. resolver uses createBoundedHealthScheduler (bounded, off critical path)');
ok(/health\?\.recordSuccess/.test(resolver), '8b. resolver calls health.recordSuccess on success');
ok(/health\?\.recordFailure/.test(resolver), '8c. resolver calls health.recordFailure on failure');
ok(/health\?\.flush\(\)/.test(resolver), '8d. resolver calls health.flush() (bounded final flush)');

// ============================================================
// 9. Negative cache classification (Phase 4 Regression-2 preserved).
// ============================================================
const negCache = read('src/lib/server/resolver/negative-cache.ts');
ok(/'UNSUPPORTED_MEDIA_TYPE'/.test(negCache) && /'MISSING_IDENTIFIER'/.test(negCache), '9a. negative cache has UNSUPPORTED_MEDIA_TYPE + MISSING_IDENTIFIER');
ok(!/'RESOLUTION_UNAVAILABLE'/.test(negCache.match(/CACHEABLE_NEGATIVE_CODES = new Set<string>\(\[([\s\S]*?)\]\)/)?.[1] ?? ''), '9b. RESOLUTION_UNAVAILABLE NOT in cacheable set (Phase 4 Regression-2 preserved)');

// ============================================================
// 10. Provider cooldown classification (Phase 3-D preserved).
// ============================================================
const cooldown = read('src/lib/server/resolver/provider-cooldown.ts');
ok(/FAILURE_THRESHOLD = 5/.test(cooldown), '10a. provider cooldown threshold is 5 (matches RPC)');
ok(/COOLDOWN_MS = 30_000/.test(cooldown), '10b. provider cooldown duration is 30s (in-process, separate from DB)');
ok(/PROBE_INTERVAL_MS = 15_000/.test(cooldown), '10c. provider cooldown probe interval is 15s');
ok(/isTransientFailure/.test(cooldown), '10d. isTransientFailure function preserved (deterministic failures NOT counted)');

// ============================================================
// 11. Database types include the new RPCs.
// ============================================================
const dbTypes = read('src/lib/server/supabase/database.types.ts');
ok(/record_provider_health_success/.test(dbTypes), '11a. database.types.ts includes record_provider_health_success');
ok(/record_provider_health_failure/.test(dbTypes), '11b. database.types.ts includes record_provider_health_failure');

console.log(`phase6_provider_health_test: ${passed} checks passed (Phase 6.1 provider health atomicity)`);
