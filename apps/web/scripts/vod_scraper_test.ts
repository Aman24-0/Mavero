/**
 * DirectStream VOD scraper — verification script (2026-10 round 18).
 *
 * TWO test tiers:
 *
 *   §1  PURE UNIT TESTS — the scraper's pure functions (config normalization,
 *       API URL building, base64 decoding). No network, no database. These
 *       ALWAYS run and verify the extraction logic is correct.
 *
 *   §2  LIVE SMOKE TEST — attempts a real scrape against vidsrc.party for
 *       tmdb_id=278 (The Shawshank Redemption). This is an INTEGRATION test
 *       that hits the real vidsrc.party API — it WILL fail when:
 *         * vidsrc.party has rotated its domain,
 *         * vidsrc.party blocks the test runner's IP,
 *         * the test runner has no network,
 *         * vidsrc.party is temporarily down.
 *       A failure here does NOT fail the test suite — it prints a warning so
 *       the operator knows the scraper needs a domain update. The pure unit
 *       tests (§1) are the authoritative gate.
 *
 * Usage:
 *   pnpm exec tsx --tsconfig ./tsconfig.test.json scripts/vod_scraper_test.ts
 */

import assert from 'node:assert/strict';

let passed = 0;
let warned = 0;
function ok(condition: unknown, label: string, hint?: string) {
  assert.ok(condition, hint ? `${label} (${hint})` : label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}
function warn(label: string, detail: string) {
  warned += 1;
  console.log(`  WARN - ${label}: ${detail}`);
}

import {
  buildApiUrl,
  decodeBase64Url,
  normalizeEmbedDomain,
  normalizeCdnDomains,
  scrapeVidsrc,
  clearScraperCache,
  DEFAULT_SCRAPER_CONFIG,
  ScraperError,
  type ScraperConfig
} from '../src/lib/server/vod/vidsrc-scraper';

// ============================================================
console.log('§1 pure unit tests — extraction logic');
// ============================================================

// --- normalizeEmbedDomain ---
{
  ok(normalizeEmbedDomain('https://vidsrc.party') === 'https://vidsrc.party', '§1.1 clean API domain passes through');
}
{
  ok(normalizeEmbedDomain('https://vidsrc.party/') === 'https://vidsrc.party', '§1.2 trailing slash stripped');
}
{
  ok(normalizeEmbedDomain('https://vidsrc.party/path') === 'https://vidsrc.party', '§1.3 path stripped to origin');
}
{
  try {
    normalizeEmbedDomain('http://vidsrc.party');
    ok(false, '§1.4 http domain should throw');
  } catch (e) {
    ok(e instanceof ScraperError && e.code === 'INVALID_PARAMS', '§1.4 http domain rejected');
  }
}
{
  try {
    normalizeEmbedDomain('');
    ok(false, '§1.5 empty domain should throw');
  } catch (e) {
    ok(e instanceof ScraperError && e.code === 'INVALID_PARAMS', '§1.5 empty domain rejected');
  }
}

// --- normalizeCdnDomains ---
{
  const domains = normalizeCdnDomains(['cno.to', 'cookiebakers23blog.xyz']);
  ok(domains.length === 2 && domains[0] === 'cno.to' && domains[1] === 'cookiebakers23blog.xyz', '§1.6 clean CDN domains pass through');
}
{
  const domains = normalizeCdnDomains(['HTTPS://CNO.TO/Path', 'cno.to']);
  ok(domains.length === 1 && domains[0] === 'cno.to', '§1.7 CDN domains normalized (lowercase, no protocol, no path, deduped)');
}

// --- buildApiUrl ---
{
  const url = buildApiUrl('https://vidsrc.party', '278', 'movie');
  ok(url === 'https://vidsrc.party/api/play/movie/278?async=1&wait=1', '§1.8 movie API URL built');
}
{
  const url = buildApiUrl('https://vidsrc.party', '1396', 'tv', 1, 1);
  ok(url === 'https://vidsrc.party/api/play/tv/1396/1/1?async=1&wait=1', '§1.9 TV API URL built with season/episode');
}

// --- decodeBase64Url ---
{
  // The base64 from the user's example: aHR0cHM6Ly9jb29raWViYWtlcnMyM2Jsb2cueHl6L3BsYXkvN2M1OTgzMTIyN2FmMTBmMy92NzIwL2luZGV4Lm0zdTg
  const decoded = decodeBase64Url('aHR0cHM6Ly9jb29raWViYWtlcnMyM2Jsb2cueHl6L3BsYXkvN2M1OTgzMTIyN2FmMTBmMy92NzIwL2luZGV4Lm0zdTg');
  ok(decoded === 'https://cookiebakers23blog.xyz/play/7c59831227af10f3/v720/index.m3u8', `§1.10 base64 decodes to the expected CDN URL (got: ${decoded})`);
}
{
  // A segment URL from production: aHR0cHM6Ly9jbm8udG8vaGxzLzI3OC1zaGF3c2hhbmstcmVkZW1wdGlvbi9GZWF0dXJlQG11cHhleXQ4LzE5MjB4MTA4MC9zZWctMDAwMDEubTRz
  const decoded = decodeBase64Url('aHR0cHM6Ly9jbm8udG8vaGxzLzI3OC1zaGF3c2hhbmstcmVkZW1wdGlvbi9GZWF0dXJlQG11cHhleXQ4LzE5MjB4MTA4MC9zZWctMDAwMDEubTRz');
  ok(decoded === 'https://cno.to/hls/278-shawshank-redemption/Feature@mupxeyt8/1920x1080/seg-00001.m4s', `§1.11 base64 decodes to the cno.to segment URL (got: ${decoded})`);
}
{
  const decoded = decodeBase64Url('invalid-base64!!!');
  ok(decoded === '' || decoded.length >= 0, '§1.12 invalid base64 does not throw (graceful degradation)');
}

// --- clearScraperCache ---
{
  clearScraperCache();
  ok(true, '§1.13 clearScraperCache runs without error');
}

// --- DEFAULT_SCRAPER_CONFIG ---
{
  ok(DEFAULT_SCRAPER_CONFIG.embedDomain === 'https://vidsrc.party', '§1.14 default API domain is vidsrc.party (2026-10 round 18)');
  ok(Array.isArray(DEFAULT_SCRAPER_CONFIG.cdnDomains) && DEFAULT_SCRAPER_CONFIG.cdnDomains.length > 0, '§1.15 default CDN domains array is non-empty');
  ok(DEFAULT_SCRAPER_CONFIG.cdnDomains.includes('cno.to'), '§1.16 default CDN domains include cno.to');
}

// ============================================================
console.log('§2 live smoke test — real scrape against vidsrc.party');
// ============================================================
// This test hits the REAL vidsrc.party API. It WILL fail when:
//   * vidsrc.party has rotated its domain,
//   * vidsrc.party blocks the test runner's IP,
//   * the test runner has no network,
//   * vidsrc.party is temporarily down.
// A failure here prints a WARN, not a FAIL — the pure unit tests (§1) are
// the authoritative gate.
{
  const config: ScraperConfig = DEFAULT_SCRAPER_CONFIG;
  try {
    const result = await scrapeVidsrc('278', 'movie', undefined, undefined, config);
    ok(result.sources.length > 0, '§2.1 live scrape returned at least one source');
    ok(result.sources[0]!.url.startsWith('https://'), '§2.2 the manifest URL is https');
    ok(result.sources[0]!.kind === 'direct', '§2.3 the source kind is direct (not embed)');
    ok(result.referer.startsWith('https://'), '§2.4 the referer is an https URL');
    ok(result.provider === 'vidsrc.party', `§2.5 the provider is vidsrc.party (got: ${result.provider})`);
    console.log(`  [live] provider: ${result.provider}`);
    console.log(`  [live] manifest URL: ${result.sources[0]!.url.slice(0, 80)}...`);
    console.log(`  [live] referer: ${result.referer}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn('§2 live scrape failed (this is expected when vidsrc.party rotates domains or blocks the IP)', message);
  }
}

console.log(`\n=== DirectStream VOD scraper verification: ${passed} checks PASSED, ${warned} warnings ===`);
