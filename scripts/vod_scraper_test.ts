/**
 * DirectStream VOD scraper — verification script (2026-10 round 13).
 *
 * Two test tiers:
 *
 *   §1  PURE UNIT TESTS — the scraper's pure functions (placeholder resolution,
 *       file-field parsing, iframe/hash extraction, config normalization).
 *       No network, no database. These ALWAYS run and verify the extraction
 *       logic is correct against known vidsrc markup shapes.
 *
 *   §2  LIVE SMOKE TEST — attempts a real scrape against the default vidsrc
 *       domain for tmdb_id=278 (The Shawshank Redemption). This is an
 *       INTEGRATION test that hits the real vidsrc.to — it WILL fail when:
 *         * vidsrc has rotated its domains (update the config + retry),
 *         * vidsrc blocks the test runner's IP (VPN/proxy block),
 *         * the test runner has no network,
 *         * vidsrc is temporarily down.
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
  resolveM3u8Placeholders,
  parseProrcpFileField,
  extractIframeSrc,
  extractProrcpHash,
  extractFileField,
  extractAllIframeSrcs,
  buildEmbedUrl,
  build2embedUrl,
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

// --- resolveM3u8Placeholders ---
{
  const resolved = resolveM3u8Placeholders('{v1}/movie/278/master.m3u8', ['cloudnestra.com']);
  ok(resolved === 'https://cloudnestra.com/movie/278/master.m3u8', '§1.1 single placeholder resolved to https URL');
}
{
  const resolved = resolveM3u8Placeholders('{v1}/path/{v2}/file.m3u8', ['cloudnestra.com', 'cdn2.example.com']);
  ok(resolved === 'https://cloudnestra.com/path/cdn2.example.com/file.m3u8', '§1.2 multiple placeholders resolved in order');
}
{
  const resolved = resolveM3u8Placeholders('{v1}/file.m3u8', []);
  ok(resolved === null, '§1.3 unresolved placeholder (no CDN domains) returns null');
}
{
  const resolved = resolveM3u8Placeholders('{v5}/file.m3u8', ['cloudnestra.com']);
  ok(resolved === null, '§1.4 placeholder index exceeds CDN list returns null');
}
{
  const resolved = resolveM3u8Placeholders('https://cloudnestra.com/file.m3u8', ['cloudnestra.com']);
  ok(resolved === 'https://cloudnestra.com/file.m3u8', '§1.5 no placeholders — URL passes through');
}
{
  const resolved = resolveM3u8Placeholders('http://cloudnestra.com/file.m3u8', ['cloudnestra.com']);
  ok(resolved === null, '§1.6 http URL rejected (https only)');
}

// --- parseProrcpFileField ---
{
  const urls = parseProrcpFileField('{v1}/movie/278/master.m3u8', ['cloudnestra.com']);
  ok(urls.length === 1 && urls[0] === 'https://cloudnestra.com/movie/278/master.m3u8', '§1.7 single file field parsed');
}
{
  const urls = parseProrcpFileField('{v1}/a.m3u8 or {v1}/b.m3u8', ['cloudnestra.com']);
  ok(urls.length === 2, '§1.8 or-separated fallbacks parsed into multiple URLs');
  ok(urls[0] === 'https://cloudnestra.com/a.m3u8' && urls[1] === 'https://cloudnestra.com/b.m3u8', '§1.9 both fallback URLs resolved');
}
{
  const urls = parseProrcpFileField('{v1}/a.m3u8 or {v1}/a.m3u8', ['cloudnestra.com']);
  ok(urls.length === 1, '§1.10 duplicate URLs deduped');
}
{
  const urls = parseProrcpFileField('', ['cloudnestra.com']);
  ok(urls.length === 0, '§1.11 empty file field returns empty array');
}
{
  const urls = parseProrcpFileField('{v9}/a.m3u8', ['cloudnestra.com']);
  ok(urls.length === 0, '§1.12 unresolvable placeholder returns empty array');
}

// --- extractIframeSrc ---
{
  const html = '<html><body><iframe src="https://cloudnestra.com/rcp/abc123" frameborder="0"></iframe></body></html>';
  ok(extractIframeSrc(html) === 'https://cloudnestra.com/rcp/abc123', '§1.13 iframe src extracted from HTML');
}
{
  const html = '<html><body><iframe data-src="https://example.com" src="https://cloudnestra.com/rcp/xyz"></iframe></body></html>';
  ok(extractIframeSrc(html) === 'https://cloudnestra.com/rcp/xyz', '§1.14 first iframe src extracted (data-src ignored)');
}
{
  const html = '<html><body><p>no iframe here</p></body></html>';
  ok(extractIframeSrc(html) === null, '§1.15 no iframe returns null');
}

// --- extractProrcpHash ---
{
  const body = '<script>var x = "/prorcp/abc123def456==";</script>';
  ok(extractProrcpHash(body) === 'abc123def456==', '§1.16 prorcp hash extracted from JS');
}
{
  const body = '<html>no hash here</html>';
  ok(extractProrcpHash(body) === null, '§1.17 no hash returns null');
}

// --- extractFileField ---
{
  const body = '<script>var data = { file: "https://cloudnestra.com/movie/278/master.m3u8" };</script>';
  ok(extractFileField(body) === 'https://cloudnestra.com/movie/278/master.m3u8', '§1.18 file field extracted from JS');
}
{
  const body = "<script>var data = { file: '{v1}/movie/278/master.m3u8' };</script>";
  ok(extractFileField(body) === '{v1}/movie/278/master.m3u8', '§1.19 file field with placeholder extracted');
}
{
  const body = '<html>no file field</html>';
  ok(extractFileField(body) === null, '§1.20 no file field returns null');
}

// --- buildEmbedUrl ---
{
  const url = buildEmbedUrl('https://vidsrc.to', '278', 'movie');
  ok(url === 'https://vidsrc.to/embed/movie/278', '§1.21 movie embed URL built');
}
{
  const url = buildEmbedUrl('https://vidsrc.to', '1396', 'tv', 1, 1);
  ok(url === 'https://vidsrc.to/embed/tv/1396/1/1', '§1.22 TV embed URL built with season/episode');
}

// --- normalizeEmbedDomain ---
{
  ok(normalizeEmbedDomain('https://vidsrc.to') === 'https://vidsrc.to', '§1.23 clean embed domain passes through');
}
{
  ok(normalizeEmbedDomain('https://vidsrc.to/') === 'https://vidsrc.to', '§1.24 trailing slash stripped');
}
{
  ok(normalizeEmbedDomain('https://vidsrc.to/path') === 'https://vidsrc.to', '§1.25 path stripped to origin');
}
{
  try {
    normalizeEmbedDomain('http://vidsrc.to');
    ok(false, '§1.26 http embed domain should throw');
  } catch (e) {
    ok(e instanceof ScraperError && e.code === 'INVALID_PARAMS', '§1.26 http embed domain rejected');
  }
}
{
  try {
    normalizeEmbedDomain('');
    ok(false, '§1.27 empty embed domain should throw');
  } catch (e) {
    ok(e instanceof ScraperError && e.code === 'INVALID_PARAMS', '§1.27 empty embed domain rejected');
  }
}

// --- normalizeCdnDomains ---
{
  const domains = normalizeCdnDomains(['cloudnestra.com', 'cdn2.example.com']);
  ok(domains.length === 2 && domains[0] === 'cloudnestra.com' && domains[1] === 'cdn2.example.com', '§1.28 clean CDN domains pass through');
}
{
  const domains = normalizeCdnDomains(['HTTPS://CloudNestra.com/Path', 'cdn2.example.com']);
  ok(domains[0] === 'cloudnestra.com', '§1.29 CDN domain normalized (lowercase, no protocol, no path)');
}
{
  const domains = normalizeCdnDomains(['cloudnestra.com', 'cloudnestra.com', '']);
  ok(domains.length === 1, '§1.30 duplicate + empty CDN domains deduped/filtered');
}

// --- cache behavior ---
{
  clearScraperCache();
  // The cache is internal; we verify clearScraperCache doesn't throw.
  ok(true, '§1.31 clearScraperCache runs without error');
}

// --- DEFAULT_SCRAPER_CONFIG ---
{
  ok(DEFAULT_SCRAPER_CONFIG.embedDomain === 'https://vidsrc.sh', '§1.32 default embed domain is vidsrc.sh (2026-10 round 15)');
  ok(Array.isArray(DEFAULT_SCRAPER_CONFIG.cdnDomains) && DEFAULT_SCRAPER_CONFIG.cdnDomains.length > 0, '§1.33 default CDN domains array is non-empty');
  ok(DEFAULT_SCRAPER_CONFIG.cdnDomains.includes('cloudnestra.com'), '§1.34 default CDN domains include cloudnestra.com');
}

// --- 2embed fallback (2026-10 round 16) ---
{
  const url = build2embedUrl('278', 'movie');
  ok(url === 'https://www.2embed.cc/embed/278', '§1.35 2embed movie URL built');
}
{
  const url = build2embedUrl('1396', 'tv', 1, 1);
  ok(url === 'https://www.2embed.cc/embedtv/1396&s=1&e=1', '§1.36 2embed TV URL built with season/episode');
}
{
  const html = '<html><iframe src="https://player.example.com/embed/abc"></iframe><iframe src="https://player2.example.com/embed/def"></iframe></html>';
  const srcs = extractAllIframeSrcs(html);
  ok(srcs.length === 2 && srcs[0] === 'https://player.example.com/embed/abc', '§1.37 extractAllIframeSrcs extracts ALL iframes');
}
{
  const html = '<iframe src="/relative/path"></iframe><iframe src="https://absolute.example.com/embed"></iframe>';
  const srcs = extractAllIframeSrcs(html);
  ok(srcs.length === 2 && srcs[0] === '/relative/path' && srcs[1] === 'https://absolute.example.com/embed', '§1.38 extractAllIframeSrcs handles relative + absolute URLs');
}
{
  const html = '<html><body><p>no iframes</p></body></html>';
  ok(extractAllIframeSrcs(html).length === 0, '§1.39 extractAllIframeSrcs returns empty when no iframes');
}

// ============================================================
console.log('§2 live smoke test — real scrape against vidsrc.to');
// ============================================================
// This test hits the REAL vidsrc.to. It WILL fail when:
//   * vidsrc has rotated its domains,
//   * vidsrc blocks the test runner's IP,
//   * the test runner has no network,
//   * vidsrc is temporarily down.
// A failure here prints a WARN, not a FAIL — the pure unit tests (§1) are
// the authoritative gate. The operator checks the WARN to know when to
// update the scraper domains.
{
  const config: ScraperConfig = DEFAULT_SCRAPER_CONFIG;
  try {
    const result = await scrapeVidsrc('278', 'movie', undefined, undefined, config);
    ok(result.sources.length > 0, '§2.1 live scrape returned at least one source');
    ok(result.sources[0]!.url.startsWith('https://'), '§2.2 the scraped source URL is https');
    ok(result.referer.startsWith('https://'), '§2.3 the referer is an https URL');
    // 2026-10 round 16: the provider is 'vidsrc' (primary) OR '2embed' (fallback).
    // Both are valid — the fallback is a legitimate success path.
    ok(result.provider === 'vidsrc' || result.provider === '2embed', `§2.4 the provider is vidsrc or 2embed (got: ${result.provider})`);
    console.log(`  [live] provider: ${result.provider}`);
    console.log(`  [live] source URL: ${result.sources[0]!.url.slice(0, 80)}...`);
    console.log(`  [live] referer: ${result.referer}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn('§2 live scrape failed (this is expected when vidsrc rotates domains or blocks the IP)', message);
  }
}

console.log(`\n=== DirectStream VOD scraper verification: ${passed} checks PASSED, ${warned} warnings ===`);
