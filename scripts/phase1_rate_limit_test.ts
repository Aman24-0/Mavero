import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkRateLimit, clientIdentity, resetRateLimitsForTests, RATE_LIMIT_RULES, MAX_TRACKED_BUCKETS, RATE_LIMITED_ERROR_CODE, RATE_LIMITED_MESSAGE } from '$lib/server/http/rate-limit';

/**
 * Phase 1 (audit SEC-003 / DL-5 / STM-11) — bounded rate limiting.
 *
 * The repository previously had ZERO application-level rate limiting while
 * its public endpoints drive real upstream cost (30-40s addon budgets,
 * TMDB classification, the 4K API). This adds the smallest practical
 * protection: a bounded per-instance fixed-window counter with a
 * consistent 429 envelope, authenticated-vs-anonymous identity separation,
 * and NO unbounded in-memory growth (the audit explicitly forbids a plain
 * unbounded `new Map()` limiter).
 *
 * The platform-level (globally shared) requirement is documented in
 * DEPLOYMENT.md — the application module never pretends per-instance
 * memory is a distributed guarantee.
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
// 1. Behavioral — burst over the limit is blocked; window resets
// ============================================================

{
  resetRateLimitsForTests();
  const rule = RATE_LIMIT_RULES.resolve;
  let baseNow = 1_000_000;
  // First `limit` requests pass.
  for (let i = 0; i < rule.limit; i += 1) {
    const verdict = checkRateLimit('resolve', 'u:user-1', baseNow + i);
    assert.equal(verdict.allowed, true, `request ${i + 1} within the limit passes`);
  }
  // The next one is blocked with a retry-after.
  const blocked = checkRateLimit('resolve', 'u:user-1', baseNow + rule.limit);
  assert.equal(blocked.allowed, false, 'the burst beyond the limit is blocked');
  assert.equal(blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= 60, true, 'retry-after is a sane bounded value');
  assert.equal(blocked.remaining, 0);
  // A different identity is INDEPENDENT (authenticated users don't collide).
  const other = checkRateLimit('resolve', 'u:user-2', baseNow + rule.limit);
  assert.equal(other.allowed, true, 'a different identity has its own budget');
  // Window expiry: after windowMs the identity can proceed again.
  const later = checkRateLimit('resolve', 'u:user-1', baseNow + rule.limit + rule.windowMs + 1);
  assert.equal(later.allowed, true, 'after the window expires the budget resets');
  ok(true, '1. fixed-window burst blocking + per-identity independence + window reset (real counters exercised)');
}

// Anonymous IPs are separate identities; missing identity shares one
// conservative bucket instead of bypassing the limit.
{
  resetRateLimitsForTests();
  const headers = new Headers({ 'x-forwarded-for': '203.0.113.7, 70.41.3.9' });
  assert.equal(clientIdentity(headers), 'ip:203.0.113.7', 'first forwarded IP is the identity');
  assert.equal(clientIdentity(new Headers()), 'ip:unknown', 'missing identity falls into a shared bucket (no bypass)');
  assert.equal(clientIdentity(new Headers(), 'user-9'), 'u:user-9', 'authenticated identity wins over IP');
  const verdict = checkRateLimit('search', 'ip:unknown');
  assert.equal(verdict.allowed, true, 'the shared anonymous bucket still functions');
  ok(true, '2. identity extraction: authenticated > forwarded IP > shared conservative bucket');
}

// Bounded memory: exceeding the bucket cap cannot grow the map.
{
  resetRateLimitsForTests();
  const rule = RATE_LIMIT_RULES.downloader4k;
  for (let i = 0; i < MAX_TRACKED_BUCKETS + 250; i += 1) {
    checkRateLimit('downloader4k', `ip:198.51.100.${i % 256}-${i}`, 5_000_000);
  }
  // The internal map is module-private; verify through behavior: a fresh
  // identity after the flood still gets served, and the rule still blocks
  // its own burst (the structure did not degrade).
  const verdict = checkRateLimit('downloader4k', 'ip:fresh-after-flood', 5_000_001);
  assert.equal(verdict.allowed, true, 'service continues after the bucket flood (bounded eviction, no crash)');
  let blocked = false;
  for (let i = 0; i < rule.limit + 5; i += 1) {
    const v = checkRateLimit('downloader4k', 'ip:burst-after-flood', 5_000_002 + i);
    if (!v.allowed) blocked = true;
  }
  assert.equal(blocked, true, 'limiting still functions after eviction pressure');
  ok(true, `3. bounded memory: ${MAX_TRACKED_BUCKETS + 250} distinct identities cannot grow the map unboundedly`);
}

// 429 envelope consistency.
{
  assert.equal(RATE_LIMITED_ERROR_CODE, 'RATE_LIMITED');
  assert.equal(typeof RATE_LIMITED_MESSAGE, 'string');
  assert.ok(RATE_LIMITED_MESSAGE.length > 0 && !/[`$\\]/.test(RATE_LIMITED_MESSAGE), 'message is a safe static string');
  ok(true, '4. the 429 envelope uses the closed RATE_LIMITED code + static message (no internal state leaked)');
}

// ============================================================
// 5. Wiring — all audited high-risk endpoints are protected
// ============================================================

const endpoints: Array<[string, RegExp, RegExp]> = [
  ['src/routes/api/playback/resolve/+server.ts', /checkRateLimit\('resolve'/, /status: 429/],
  ['src/routes/api/downloader/mavero/+server.ts', /checkRateLimit\('downloaderMavero'/, /status: 429/],
  ['src/routes/api/downloader/mavero/addon/+server.ts', /checkRateLimit\('downloaderAddon'/, /status: 429/],
  ['src/routes/api/downloader/mavero/tabs/+server.ts', /checkRateLimit\('downloaderTabs'/, /status: 429/],
  ['src/routes/api/downloader/4k/+server.ts', /checkRateLimit\('downloader4k'/, /status: 429/],
  ['src/routes/api/content/search/+server.ts', /checkRateLimit\('search'/, /status: 429/],
  ['src/routes/api/playback/stremio/session/+server.ts', /checkRateLimit\('stremioSession'/, /status: 429/],
];
for (const [file, wiring, status] of endpoints) {
  const source = read(file);
  assert.match(source, wiring, `${file} applies its rate-limit rule`);
  assert.match(source, status, `${file} returns the consistent 429`);
  assert.match(source, /retry-after/, `${file} exposes retry-after`);
  assert.match(source, /RATE_LIMITED_ERROR_CODE/, `${file} uses the closed error code`);
}
ok(true, '5. all 7 audited high-risk public endpoints wired to the limiter (consistent 429 + retry-after)');

// The limiter module is bounded by construction and honest about serverless.
{
  const source = read('src/lib/server/http/rate-limit.ts');
  assert.match(source, /MAX_TRACKED_BUCKETS = 10_000/, 'hard bucket cap exists');
  assert.match(source, /NOT shared across Netlify function instances|not a global guarantee/i, 'the serverless honesty contract is documented in-module');
  const deployment = read('DEPLOYMENT.md');
  assert.match(deployment, /Rate limiting and abuse protection \(Phase 1, audit SEC-003\)/, 'DEPLOYMENT.md documents the deployment-level requirement');
  assert.match(deployment, /Netlify|edge|WAF/i, 'the platform configuration guidance is present');
  ok(true, '6. bounded by construction + deployment-level requirement documented (no false distributed guarantee)');
}

console.log(`phase1_rate_limit_test: ${passed} checks passed (bounded rate limiting on high-risk public endpoints)`);
