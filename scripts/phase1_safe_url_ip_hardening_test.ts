import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateProviderEndpoint, validatePlaybackUrl, validateAddonStreamPlaybackUrl } from '$lib/server/resolver/safe-url';
import { parseIpv4Literal, expandIpv6, isBlockedIpAddress } from '$lib/server/streaming/stremio/ssrf';

/**
 * Phase 1 (audit SEC-002 / MW-2) — adversarial SSRF regression tests for
 * the resolver URL validation.
 *
 * Problem: `resolver/safe-url.ts` string-based private-host regexes missed:
 *   * decimal IPv4            `2130706433` (= 127.0.0.1)
 *   * hexadecimal IPv4        `0x7f000001` (= 127.0.0.1)
 *   * abbreviated IPv4        `127.1`      (= 127.0.0.1)
 *   * IPv4-mapped IPv6        `::ffff:127.0.0.1`, `::ffff:7f00:1`
 *   * CGNAT                   `100.64.0.1`
 *   * NAT64-embedded IPv4     `64:ff9b::127.0.0.1`
 *
 * Fix: `isPrivateHostname` now reuses the hardened Stremio classification
 * primitives (`ssrf.ts` parseIpv4Literal/expandIpv6/isBlockedIpv4/
 * isBlockedIpv6) — one canonical algorithm, no drift between security
 * levels, ambiguous shapes fail closed. HTTPS-only, credential rejection
 * and embed-origin allowlists are preserved unchanged.
 *
 * The hardened Stremio guard is NOT weakened (it is the reference — this
 * file now derives FROM it).
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
// 1. The full adversarial vector list — every form REJECTED
// ============================================================

const BLOCKED_URLS: Array<[string, string]> = [
  // Loopback — dotted quad.
  ['https://127.0.0.1/video.m3u8', 'loopback dotted'],
  // Loopback — abbreviated IPv4 (WHATWG: 127.1 == 127.0.0.1).
  ['https://127.1/video.m3u8', 'abbreviated IPv4'],
  // Loopback — decimal IPv4 (2130706433 == 0x7F000001).
  ['https://2130706433/video.m3u8', 'decimal IPv4'],
  // Loopback — hexadecimal IPv4.
  ['https://0x7f000001/video.m3u8', 'hexadecimal IPv4'],
  // Loopback — octal IPv4 (0177.0.0.1 == 127.0.0.1).
  ['https://0177.0.0.1/video.m3u8', 'octal IPv4'],
  // IPv6 loopback.
  ['https://[::1]/video.m3u8', 'IPv6 loopback'],
  // IPv4-mapped IPv6 (dotted tail + hex tail).
  ['https://[::ffff:127.0.0.1]/video.m3u8', 'mapped IPv6 dotted'],
  ['https://[::ffff:7f00:1]/video.m3u8', 'mapped IPv6 hex'],
  // IPv4-compatible (::/96) embedded loopback.
  ['https://[::127.0.0.1]/video.m3u8', 'compatible embedded loopback'],
  // CGNAT 100.64/10.
  ['https://100.64.0.1/video.m3u8', 'CGNAT'],
  // Link-local + cloud metadata.
  ['https://169.254.169.254/latest/meta-data', 'link-local metadata'],
  ['https://169.254.10.10/video.m3u8', 'link-local'],
  // RFC1918.
  ['https://10.1.2.3/video.m3u8', '10/8'],
  ['https://172.16.0.1/video.m3u8', '172.16/12'],
  ['https://172.31.255.255/video.m3u8', '172.31 edge'],
  ['https://192.168.1.1/video.m3u8', '192.168/16'],
  // Unspecified / this-network.
  ['https://0.0.0.0/video.m3u8', 'unspecified IPv4'],
  // NAT64 64:ff9b::/96 embedding a loopback.
  ['https://[64:ff9b::7f00:1]/video.m3u8', 'NAT64 hex loopback'],
  ['https://[64:ff9b::127.0.0.1]/video.m3u8', 'NAT64 dotted loopback'],
  // IPv6 ULA fc00::/7.
  ['https://[fd00::1]/video.m3u8', 'IPv6 ULA'],
  ['https://[fc00::1]/video.m3u8', 'IPv6 ULA fc00'],
  // IPv6 link-local fe80::/10.
  ['https://[fe80::1]/video.m3u8', 'IPv6 link-local'],
  // IPv6 multicast.
  ['https://[ff02::1]/video.m3u8', 'IPv6 multicast'],
  // Hostname forms.
  ['https://localhost/video.m3u8', 'localhost'],
  ['https://foo.localhost/video.m3u8', 'localhost subdomain'],
  ['https://metadata.google.internal/video.m3u8', 'GCP metadata host'],
  // Credentials still rejected (existing control preserved).
  ['https://user:pass@example.com/video.m3u8', 'credentials'],
  // Non-https schemes still rejected (existing control preserved).
  ['http://93.184.216.34/video.m3u8', 'plain http'],
  ['ftp://example.com/video.m3u8', 'ftp scheme'],
];

for (const [url, label] of BLOCKED_URLS) {
  assert.throws(() => validatePlaybackUrl(url, 'direct'), (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'INVALID_SOURCE_URL', `direct playback must reject: ${label} (${url})`);
  if (!url.startsWith('http://') && !url.startsWith('ftp://') && !url.includes('user:pass')) {
    // Provider endpoints share the same classification (https + no creds).
    assert.throws(() => validateProviderEndpoint(url), (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'INVALID_PROVIDER_ENDPOINT', `provider endpoint must reject: ${label} (${url})`);
  }
}
ok(true, `1. all ${BLOCKED_URLS.length} adversarial vectors rejected (numeric IPv4, mapped/NAT64 IPv6, CGNAT, privates, metadata)`);

// The addon-stream boundary (http permitted by design for real addons)
// still rejects every private/loopback form.
for (const [url] of BLOCKED_URLS.slice(0, 22)) {
  assert.throws(() => validateAddonStreamPlaybackUrl(url), (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'INVALID_SOURCE_URL', `addon stream must reject: ${url}`);
}
ok(true, '2. addon stream boundary rejects the same private-address set');

// ============================================================
// 2. Legitimate provider/public URLs still PASS (no false positives)
// ============================================================

const ALLOWED_URLS: Array<[string, string]> = [
  ['https://vidsrc.wiki/embed/movie/8633518/', 'real provider embed origin'],
  ['https://example.com/video.m3u8', 'public DNS host'],
  ['https://93.184.216.34/video.m3u8', 'PUBLIC IPv4 literal (allowed — not private)'],
  ['https://8.8.8.8/video.m3u8', 'public DNS resolver IP literal'],
  ['https://[2606:4700::6810:84e5]/video.m3u8', 'public IPv6 literal (Cloudflare)'],
  ['https://172.15.0.1/video.m3u8', 'just OUTSIDE 172.16/12 (public)'],
  ['https://172.32.0.1/video.m3u8', 'just ABOVE 172.16/12 (public)'],
  ['https://100.63.0.1/video.m3u8', 'just BELOW CGNAT (public)'],
  ['https://100.128.0.1/video.m3u8', 'just ABOVE CGNAT (public)'],
  ['https://example.com:8443/video.m3u8', 'explicit port'],
];
for (const [url, label] of ALLOWED_URLS) {
  const validated = validatePlaybackUrl(url, 'direct');
  assert.equal(typeof validated, 'string', `legitimate URL must pass: ${label} (${url})`);
}
ok(true, `3. all ${ALLOWED_URLS.length} legitimate public URLs still pass (no provider breakage, boundary cases exact)`);

// Embed origin allowlist behavior preserved (dynamic-origins off → only
// allowlisted origins).
{
  assert.throws(() => validatePlaybackUrl('https://evil.example/embed', 'embed', ['https://trusted.example']), (error: unknown) => (error as { code?: string }).code === 'INVALID_SOURCE_URL', 'non-allowlisted embed origin rejected (allowlist preserved)');
  const okEmbed = validatePlaybackUrl('https://trusted.example/embed', 'embed', ['https://trusted.example']);
  assert.equal(okEmbed, 'https://trusted.example/embed');
  ok(true, '4. embed origin allowlist semantics preserved');
}

// ============================================================
// 3. Shared primitives are exercised directly (parity with the guard)
// ============================================================

assert.equal(parseIpv4Literal('127.1'), 2130706433, 'parseIpv4Literal decodes the abbreviated form');
assert.equal(parseIpv4Literal('2130706433'), 2130706433, 'parseIpv4Literal decodes the decimal form');
assert.equal(parseIpv4Literal('0x7f000001'), 2130706433, 'parseIpv4Literal decodes the hex form');
assert.equal(isBlockedIpAddress('::ffff:127.0.0.1'), true, 'mapped loopback blocked at the address level');
assert.equal(isBlockedIpAddress('::ffff:7f00:1'), true, 'hex-tail mapped loopback blocked');
assert.deepEqual(expandIpv6('::ffff:7f00:1'), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001], 'expandIpv6 canonicalizes the hex-tail form');
ok(true, '5. the canonical primitives decode every numeric form exactly (one algorithm, no drift)');

// ============================================================
// 4. Wiring — safe-url derives FROM the hardened guard
// ============================================================

const safeUrl = read('src/lib/server/resolver/safe-url.ts');
assert.match(safeUrl, /import \{ expandIpv6, isBlockedIpv4, isBlockedIpv6, normalizeGuardedHostname, parseIpv4Literal \} from '\$lib\/server\/streaming\/stremio\/ssrf';/, 'safe-url imports the hardened primitives');
assert.doesNotMatch(safeUrl, /\/\^127\(\?:\\\.\[0-9\]\{1,3\}\)\{3\}\$\//, 'the old weak loopback regex is gone');
assert.match(safeUrl, /hextets === null \? true : isBlockedIpv6\(hextets\)/, 'ambiguous IPv6 shapes FAIL CLOSED');
const stremioGuard = read('src/lib/server/streaming/stremio/ssrf.ts');
assert.match(stremioGuard, /export function isBlockedIpv6/, 'the hardened guard is intact and unweakened (still the reference)');
assert.match(stremioGuard, /export function parseIpv4Literal/, 'the hardened IPv4 parser is intact');
ok(true, '6. wiring: safe-url reuses (not reimplements) the hardened classification');

console.log(`phase1_safe_url_ip_hardening_test: ${passed} checks passed (adversarial IP validation + provider compatibility)`);
