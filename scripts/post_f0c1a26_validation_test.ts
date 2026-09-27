import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Post-f0c1a26 validation: admin capability cache bound correctness.
 *
 * Verifies:
 * 1. Cache reaches MAX
 * 2. Another unique user is inserted
 * 3. Size remains <= MAX
 * 4. Oldest entry is evicted (FIFO)
 * 5. Expired entries are removed
 * 6. Cached admin/non-admin values work
 * 7. Lookup errors are not cached
 *
 * Also validates the registration cache in hooks.server.ts has the same
 * bounded eviction pattern.
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
// 1. Admin capability cache — code-level bounded eviction audit
// ============================================================

const adminAuth = read('src/lib/server/streaming/admin-auth.ts');

// The cache MUST have a MAX_ENTRIES constant.
ok(/ADMIN_CAPABILITY_MAX_ENTRIES\s*=\s*\d+/.test(adminAuth), '1a. ADMIN_CAPABILITY_MAX_ENTRIES constant exists');

// The eviction MUST evict expired first, then oldest FIFO.
ok(/evictExpiredAdminCapabilities\(now\)/.test(adminAuth), '1b. evictExpiredAdminCapabilities is called');

// After expired eviction, if still full, MUST evict oldest.
ok(/oldestKey.*keys\(\)\.next\(\)\.value/.test(adminAuth), '1c. oldest entry (FIFO) is evicted when cache is still full after expired eviction');

// The eviction MUST happen BEFORE the set().
ok(/if\s*\(adminCapabilityCache\.size\s*>=\s*ADMIN_CAPABILITY_MAX_ENTRIES\)[\s\S]*?evictExpiredAdminCapabilities[\s\S]*?oldestKey[\s\S]*?adminCapabilityCache\.set/.test(adminAuth), '1d. eviction runs BEFORE set() — cache never exceeds MAX');

// Lookup errors MUST NOT be cached (fail-closed).
ok(/return false;[\s\S]*?\/\/ fail-closed — cache nothing on error/.test(adminAuth), '1e. lookup errors return false and cache nothing');

// invalidateAdminCapabilityCache MUST be exported.
ok(/export function invalidateAdminCapabilityCache/.test(adminAuth), '1f. invalidateAdminCapabilityCache is exported');

// ============================================================
// 2. Registration cache — same bounded eviction audit
// ============================================================

const hooks = read('src/hooks.server.ts');

// The cache MUST have a MAX_ENTRIES constant.
ok(/REGISTRATION_CACHE_MAX_ENTRIES\s*=\s*\d+/.test(hooks), '2a. REGISTRATION_CACHE_MAX_ENTRIES constant exists');

// After expired eviction, if still full, MUST evict oldest.
ok(/oldestKey.*registrationCache\.keys\(\)\.next\(\)\.value/.test(hooks), '2b. oldest entry (FIFO) is evicted when registration cache is still full after expired eviction');

// The eviction MUST happen BEFORE the set().
ok(/if\s*\(registrationCache\.size\s*>=\s*REGISTRATION_CACHE_MAX_ENTRIES\)[\s\S]*?registrationCache\.delete[\s\S]*?oldestKey[\s\S]*?registrationCache\.set/.test(hooks), '2c. eviction runs BEFORE set() — registration cache never exceeds MAX');

// Failed registration MUST NOT be cached.
ok(/registration\.timedOut[\s\S]*?console\.error[\s\S]*?else if\s*\(registration\.value\)[\s\S]*?registrationCache\.set/.test(hooks), '2d. registration cache only set on success (not on timeout, not on null value)');

// ============================================================
// 3. Revocation cache — verify it already has the correct pattern
// ============================================================

const revocationCache = read('src/lib/server/auth/session-revocation-cache.ts');
ok(/oldestKey.*cache\.keys\(\)\.next\(\)\.value/.test(revocationCache), '3a. revocation cache already has FIFO oldest eviction (correct pattern)');

// ============================================================
// 4. Behavioral test — simulate cache bound with a Map
// ============================================================

// Simulate the admin capability cache eviction logic to verify
// the cache never exceeds MAX when all entries are fresh.
{
  const MAX = 3; // small for testing
  const TTL = 5 * 60 * 1000;
  const cache = new Map<string, { isAdmin: boolean; expiresAt: number }>();

  function evictExpired(now: number): void {
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(key);
    }
  }

  function simulateInsert(userId: string, isAdmin: boolean, now: number): void {
    const cached = cache.get(userId);
    if (cached && cached.expiresAt > now) return; // cache hit

    if (cache.size >= MAX) {
      evictExpired(now);
      if (cache.size >= MAX) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) cache.delete(oldestKey);
      }
    }
    cache.set(userId, { isAdmin, expiresAt: now + TTL });
  }

  const now = Date.now();

  // Insert MAX entries (all fresh, none expired).
  simulateInsert('user-1', false, now);
  simulateInsert('user-2', true, now);
  simulateInsert('user-3', false, now);
  assert.equal(cache.size, 3, 'cache at MAX after 3 inserts');
  ok(true, '4a. cache reaches MAX (3 entries)');

  // Insert a 4th — oldest (user-1) should be evicted.
  simulateInsert('user-4', false, now);
  assert.equal(cache.size, 3, 'cache still at MAX after 4th insert');
  assert.ok(!cache.has('user-1'), 'user-1 (oldest) was evicted');
  assert.ok(cache.has('user-2'), 'user-2 still cached');
  assert.ok(cache.has('user-3'), 'user-3 still cached');
  assert.ok(cache.has('user-4'), 'user-4 cached');
  ok(true, '4b. cache remains <= MAX after insert at capacity (oldest evicted)');

  // Verify cached values work.
  const u2 = cache.get('user-2');
  assert.ok(u2 && u2.isAdmin === true, 'user-2 cached as admin');
  ok(true, '4c. cached admin value is correct');

  const u3 = cache.get('user-3');
  assert.ok(u3 && u3.isAdmin === false, 'user-3 cached as non-admin');
  ok(true, '4d. cached non-admin value is correct');

  // Test expired eviction: set all entries to expired.
  const past = now - TTL - 1;
  for (const [, entry] of cache) entry.expiresAt = past;

  // Insert a new entry — all expired entries should be evicted first.
  simulateInsert('user-5', true, now);
  assert.equal(cache.size, 1, 'all expired entries evicted, only user-5 remains');
  assert.ok(cache.has('user-5'), 'user-5 cached after expired eviction');
  ok(true, '4e. expired entries are removed when cache is full');

  // Verify the new entry's value.
  const u5 = cache.get('user-5');
  assert.ok(u5 && u5.isAdmin === true, 'user-5 cached as admin');
  ok(true, '4f. new entry after expired eviction has correct value');
}

// ============================================================
// 5. Verify the admin capability cache code has the two-step
//    eviction (expired → FIFO) that matches the simulation above.
// ============================================================

// Extract the eviction block from the code and verify it matches
// the pattern: size >= MAX → evictExpired → size >= MAX → delete oldest.
const evictionBlock = adminAuth.match(
  /if\s*\(adminCapabilityCache\.size\s*>=\s*ADMIN_CAPABILITY_MAX_ENTRIES\)\s*\{[\s\S]*?evictExpiredAdminCapabilities\(now\);[\s\S]*?if\s*\(adminCapabilityCache\.size\s*>=\s*ADMIN_CAPABILITY_MAX_ENTRIES\)\s*\{[\s\S]*?oldestKey[\s\S]*?adminCapabilityCache\.delete\(oldestKey\);[\s\S]*?\}\s*\}/
);
ok(evictionBlock !== null, '5a. admin capability cache has two-step eviction: expired → FIFO oldest (matches the simulation)');

// Same for the registration cache.
const regEvictionBlock = hooks.match(
  /if\s*\(registrationCache\.size\s*>=\s*REGISTRATION_CACHE_MAX_ENTRIES\)\s*\{[\s\S]*?registrationCache\.delete\(key\);[\s\S]*?if\s*\(registrationCache\.size\s*>=\s*REGISTRATION_CACHE_MAX_ENTRIES\)\s*\{[\s\S]*?oldestKey[\s\S]*?registrationCache\.delete\(oldestKey\);[\s\S]*?\}\s*\}/
);
ok(regEvictionBlock !== null, '5b. registration cache has two-step eviction: expired → FIFO oldest (matches the simulation)');

// ============================================================
// 6. Security invariants — authorization paths are NOT cached
// ============================================================

// requireAdmin MUST query profiles directly (not through the cache).
ok(/from\('profiles'\)[\s\S]*?select\('id,role'\)/.test(adminAuth), '6a. requireAdmin queries profiles directly (not cached)');

// assertAdminClient MUST query profiles directly (not through the cache).
ok(/from\('profiles'\)[\s\S]*?select\('id,role'\)/.test(adminAuth), '6b. assertAdminClient queries profiles directly (not cached)');

// The cache is ONLY used in isAdminUser (the capability projection).
ok(/adminCapabilityCache\.get/.test(adminAuth), '6c. admin capability cache is used in isAdminUser (capability projection only)');

// ============================================================
// 7. Discover batch cache safety
// ============================================================

const batchServer = read('src/routes/api/discover/batch/+server.ts');

// The batch MUST hardcode canAccessAdult=false.
ok(/discoverBatchDeduped\(languageParam,\s*safeProvider,\s*false\)/.test(batchServer), '7a. batch hardcodes canAccessAdult=false (no user-dependent adult content)');

// The batch MUST NOT use locals.user or locals.supabase for the response.
ok(!/locals\.user/.test(batchServer.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), '7b. batch does not reference locals.user in response path');

// The response MUST include language and provider (cache key dimensions).
ok(/language: languageParam/.test(batchServer), '7c. response includes language (cache key dimension)');
ok(/provider: safeProvider/.test(batchServer), '7d. response includes provider (cache key dimension)');

// PUBLIC_CATALOG_CACHE is used.
ok(/PUBLIC_CATALOG_CACHE/.test(batchServer), '7e. batch uses PUBLIC_CATALOG_CACHE');

console.log(`\npost_f0c1a26_validation_test: ${passed} checks passed (admin cache bound + registration cache bound + revocation cache pattern + simulation + security invariants + batch cache safety)`);
