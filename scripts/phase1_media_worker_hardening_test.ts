import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { isPrivateIpLiteral, validateJobUrl } from '../apps/media-worker/src/validate';
import { buildFfmpegArgs, HTTPS_PROTOCOL_WHITELIST, FILE_PROTOCOL_WHITELIST, protocolWhitelistFor } from '../apps/media-worker/src/ffmpeg';
import { parseIpv4Literal, expandIpv6, isBlockedIpAddress } from '../apps/media-worker/src/ip-guard';
import { JobRegistry } from '../apps/media-worker/src/jobs';
import type { WorkerConfig } from '../apps/media-worker/src/config';

/**
 * Phase 1 (audit MW-1 / MW-2 / MW-3) — media worker hardening.
 *
 * MW-1: ffmpeg input had NO protocol whitelist — a nested playlist could
 *       introduce protocols that bypass the app's URL validation
 *       (file://, http:// to metadata endpoints, data:, …).
 *       Fix: `-protocol_whitelist` on BOTH ffprobe and ffmpeg, restricted
 *       to the legitimate workflow (https + tls/tcp transport + crypto for
 *       AES-128 HLS segments; `file` only for the documented local-test
 *       helper path).
 *
 * MW-2: the worker's literal checks missed hex-tail IPv4-mapped IPv6
 *       (`::ffff:7f00:1`) and numeric IPv4 forms (decimal/hex/abbreviated
 *       loopback) — the audit's end-to-end loopback chain. Fix: canonical
 *       classification (ip-guard.ts — same algorithm as the app-side
 *       hardened guard, PARITY-TESTED below), ambiguous shapes fail closed.
 *
 * MW-3: failed jobs retained partial output up to the 3h TTL; repeated
 *       failures accumulated to the per-job budget and tripped the
 *       free-disk gate. Fix: prompt, job-scoped, traversal-free cleanup on
 *       failure; ready/ended jobs keep serving until their intended expiry.
 *
 * The worker is a separately deployed package (own package.json/tsconfig);
 * behavioral tests here run its REAL modules under tsx.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ============================================================
// 1. MW-2 — adversarial IP literals rejected by the worker
// ============================================================

const BLOCKED_LITERALS: Array<[string, string]> = [
  ['127.0.0.1', 'loopback dotted'],
  ['127.1', 'abbreviated IPv4'],
  ['2130706433', 'decimal IPv4'],
  ['0x7f000001', 'hexadecimal IPv4'],
  ['0177.0.0.1', 'octal IPv4'],
  ['::1', 'IPv6 loopback'],
  ['::ffff:127.0.0.1', 'mapped IPv6 dotted'],
  ['::ffff:7f00:1', 'mapped IPv6 HEX (the audit bypass)'],
  ['::127.0.0.1', 'compatible embedded loopback'],
  ['100.64.0.1', 'CGNAT'],
  ['169.254.169.254', 'cloud metadata'],
  ['10.0.0.1', '10/8'],
  ['172.16.0.9', '172.16/12'],
  ['192.168.1.1', '192.168/16'],
  ['0.0.0.0', 'unspecified'],
  ['64:ff9b::7f00:1', 'NAT64 loopback'],
  ['fd00::1', 'IPv6 ULA'],
  ['fe80::1', 'IPv6 link-local'],
  ['ff02::1', 'IPv6 multicast'],
];

for (const [literal, label] of BLOCKED_LITERALS) {
  assert.equal(isPrivateIpLiteral(literal), true, `worker must classify as private: ${label} (${literal})`);
  assert.equal(isBlockedIpAddress(literal), true, `canonical classifier must block: ${literal}`);
}
ok(true, `1. all ${BLOCKED_LITERALS.length} adversarial literals classified private (incl. hex-tail mapped IPv6 + numeric IPv4)`);

// Public addresses still allowed (no false positives).
for (const literal of ['93.184.216.34', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '2606:4700::6810:84e5']) {
  assert.equal(isPrivateIpLiteral(literal), false, `public address must remain allowed: ${literal}`);
}
ok(true, '2. public addresses remain allowed (boundary cases exact)');

// URL-level validation: https-only, no creds, private literals rejected.
{
  assert.equal(validateJobUrl('https://media.example/video.mkv').ok, true, 'legitimate https input accepted');
  for (const url of ['https://127.0.0.1/v.mkv', 'https://[::ffff:7f00:1]/v.mkv', 'https://2130706433/v.mkv', 'http://media.example/v.mkv', 'file:///etc/passwd', 'https://u:p@media.example/v.mkv']) {
    assert.equal(validateJobUrl(url).ok, false, `worker job URL must reject: ${url}`);
  }
  ok(true, '3. validateJobUrl: https-only + credential + private-literal boundaries hold end-to-end');
}

// PARITY: the worker's canonical classifier agrees with the app-side guard
// on every vector (the two stacks must never drift).
{
  const appSsrf = await import('../src/lib/server/streaming/stremio/ssrf');
  for (const [literal] of BLOCKED_LITERALS) {
    assert.equal(isBlockedIpAddress(literal), appSsrf.isBlockedIpAddress(literal), `parity violation on ${literal}`);
  }
  for (const literal of ['93.184.216.34', '8.8.8.8', '2606:4700::6810:84e5']) {
    assert.equal(isBlockedIpAddress(literal), appSsrf.isBlockedIpAddress(literal), `parity violation on public ${literal}`);
  }
  ok(true, '4. PARITY: worker ip-guard === app-side hardened guard on all vectors (one canonical approach)');
}

// The primitives decode exactly like the reference implementation.
{
  assert.equal(parseIpv4Literal('127.1'), parseIpv4Literal('127.0.0.1'));
  assert.deepEqual(expandIpv6('::ffff:7f00:1'), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
  assert.equal(expandIpv6('::gg::'), null, 'malformed IPv6 fails closed');
  ok(true, '5. canonical primitives decode/expand exactly (fail closed on garbage)');
}

// ============================================================
// 2. MW-1 — ffmpeg protocol whitelist
// ============================================================

{
  const httpsUrl = new URL('https://media.example/video.mkv');
  assert.equal(protocolWhitelistFor(httpsUrl), HTTPS_PROTOCOL_WHITELIST, 'https input uses the https whitelist');
  assert.equal(HTTPS_PROTOCOL_WHITELIST.split(',').every((p) => ['https', 'tcp', 'tls', 'crypto'].includes(p)), true, 'https whitelist is the minimal legitimate set');
  assert.equal(protocolWhitelistFor(new URL('file:///tmp/test.mkv')), FILE_PROTOCOL_WHITELIST, 'the documented local-test file helper keeps its narrow whitelist');

  const args = buildFfmpegArgs({
    ffmpegPath: 'ffmpeg',
    inputUrl: httpsUrl,
    outDir: '/tmp/job-out',
    kind: 'remux',
    timeoutMs: 60_000,
    maxOutputBytes: 1024,
    durationSeconds: 100,
    maxDurationSeconds: 600,
  });
  const whitelistIndex = args.indexOf('-protocol_whitelist');
  assert.ok(whitelistIndex >= 0, 'ffmpeg argv carries the protocol whitelist');
  assert.equal(args[whitelistIndex + 1], HTTPS_PROTOCOL_WHITELIST, 'whitelist precedes -i (input-bound)');
  assert.ok(whitelistIndex < args.indexOf('-i'), 'whitelist is an input option (before -i)');
  // The whitelist forbids the audit's nested-playlist vectors (exact
  // protocol membership, not substring matching).
  const allowedProtocols = HTTPS_PROTOCOL_WHITELIST.split(',');
  for (const forbidden of ['file', 'http', 'data', 'pipe', 'concat', 'rtmp', 'udp', 'ftp']) {
    assert.equal(allowedProtocols.includes(forbidden), false, `whitelist must NOT include ${forbidden}`);
  }
  ok(true, '6. ffmpeg argv enforces the protocol whitelist (nested playlists cannot re-open file/http/data/...)');
}

// ============================================================
// 3. MW-3 — failed-job cleanup
// ============================================================

// The jobs under test are QUEUED but never started (maxConcurrentJobs: 0)
// so the real ffprobe/ffmpeg binaries are never spawned: the failure path
// (fail()) is driven deterministically through the public
// reportEncoderFailure route — the exact route server.ts uses.
function workerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    port: 0,
    secret: 'test-secret',
    publicBaseUrl: 'http://127.0.0.1:8787',
    allowedOrigin: '*',
    maxConcurrentJobs: 0,
    maxQueueDepth: 4,
    maxJobOutputBytes: 1024 * 1024,
    maxInputDurationSeconds: 3600,
    jobTtlSeconds: 3 * 3600,
    readyWaitMs: 2000,
    cleanupIntervalMs: 60_000,
    ffmpegPath: '/nonexistent/ffmpeg',
    ffprobePath: '/nonexistent/ffprobe',
    minFreeDiskBytes: 0,
    ...overrides,
  };
}

// Public-answer DNS sweep stub (no network in tests — the real sweep is
// behaviorally covered by the MW-2 classification tests above).
const fakeDnsCheck = (async () => ({ ok: true as const, url: new URL('https://media.example/video.mkv') }));

const TOKEN_PAYLOAD = {
  u: 'https://media.example/video.mkv',
  s: 'session-1',
  a: 'addon-1',
  c: 'movie-8633518',
  m: 'movie',
  k: 'remux' as const,
  exp: Date.now() + 3600_000,
};

// 3a. A job that fails BEFORE readiness has its partial output removed
// promptly (not after the 3h TTL).
{
  const registry = new JobRegistry(workerConfig(), fakeDnsCheck);
  const submitted = await registry.submit('token-failed-job', TOKEN_PAYLOAD as never);
  assert.equal(submitted.outcome, 'queued', 'the job is queued (never started — no probe spawn)');
  const jobId = submitted.job.id;
  const dir = registry.dirFor(jobId);
  assert.ok(dir, 'the job directory exists');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'seg-00000.ts'), 'partial-output');

  (registry as unknown as { reportEncoderFailure: (job: never, code: string, message?: string) => void }).reportEncoderFailure(submitted.job as never, 'FFMPEG_FAILED', 'encode blew up');

  const snapshot = registry.snapshot(jobId);
  assert.equal(snapshot?.status, 'failed', 'the job is failed');
  await new Promise((resolve) => setTimeout(resolve, 120)); // let the async removal settle
  assert.equal(existsSync(dir), false, 'partial output removed PROMPTLY on failure (was: retained up to 3h TTL)');
  assert.equal(registry.dirFor(jobId), null, 'the directory mapping is released');
  ok(true, '3a. failed-job cleanup happens promptly, scoped to the job directory');
}

// 3b. Cleanup cannot touch other jobs' files; READY-adjacent output of a
// second job survives the first job's failure.
{
  const registry = new JobRegistry(workerConfig(), fakeDnsCheck);
  const first = await registry.submit('token-a', TOKEN_PAYLOAD as never);
  const second = await registry.submit('token-b', { ...TOKEN_PAYLOAD, s: 'session-2' } as never);
  assert.equal(first.outcome, 'queued');
  assert.equal(second.outcome, 'queued');
  const firstDir = registry.dirFor(first.job.id);
  const secondDir = registry.dirFor(second.job.id);
  assert.ok(firstDir && secondDir && firstDir !== secondDir, 'each job owns a distinct directory');
  mkdirSync(secondDir, { recursive: true });
  writeFileSync(path.join(secondDir, 'playlist.m3u8'), '#EXTM3U\n#EXTINF:4,\nseg-00000.ts\n');

  (registry as unknown as { reportEncoderFailure: (job: never, code: string) => void }).reportEncoderFailure(first.job as never, 'FFMPEG_FAILED');
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(existsSync(path.join(secondDir, 'playlist.m3u8')), true, "the other job's output is untouched by another job's failure");
  registry.stopSweeper();
  ok(true, '3b. cleanup is job-scoped (no cross-job deletion, no traversal surface)');
}

// 3c. Static: the cleanup lives in the failure path; ready/ended jobs are
// excluded (their output must remain served until expiry), and the cleanup
// log carries NO secrets/tokens/URLs.
{
  const jobs = readFileSync(path.join(REPO_ROOT, 'apps/media-worker/src/jobs.ts'), 'utf8');
  const failBody = jobs.slice(jobs.indexOf('private fail(job: Job'), jobs.indexOf('reportEncoderFailure'));
  assert.match(failBody, /const live = this\.jobs\.get\(job\.id\) \?\? job;/, 'failure state lands on the LIVE registry job (snapshot copies are inputs only)');
  assert.match(failBody, /void rm\(dir, \{ recursive: true, force: true \}\)/, 'fail() performs the prompt removal');
  assert.match(failBody, /if \(live\.status === 'ready'\) \{\s*\n\s*live\.phase = 'ended';/, 'ready jobs keep serving (ended phase, no cleanup)');
  assert.match(failBody, /jobId: live\.id, code \}/, 'cleanup logging carries job id + code only (no secrets/tokens/URLs)');
  ok(true, '3c. cleanup policy: failure-path only, ready/ended exempt, safe logging');
}

// Clean up the temp roots created by the test.
rmSync(path.join(tmpdir(), 'mavero-media-worker'), { recursive: true, force: true });

console.log(`phase1_media_worker_hardening_test: ${passed} checks passed (protocol whitelist + canonical IP guard + failed-job cleanup)`);
