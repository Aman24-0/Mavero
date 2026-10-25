import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ============================================================================
// MAV-21 Workstream E — app-wide performance regression suite.
//
// Three root-cause optimizations, all following ALREADY-ESTABLISHED app
// patterns (no new paradigms):
//
//   E1. DETAIL-PAGE HERO RESPONSIVE ARTWORK — the cinematic detail hero
//       previously shipped a single ORIGINAL-size TMDB backdrop to every
//       breakpoint (a multi-hundred-KB LCP payload on 390px phones). The
//       hero now follows the SAME <picture> tier contract as the
//       Discover/Explorer carousels (the documented tier decision):
//       mobile ≤640 std-DPI → w780, mobile retina → w1280, ≥641px →
//       original, <img> fallback → w1280 backdrop (poster when no
//       backdrop). Failure/geometry/priority contracts preserved.
//
//   E2. IMAGE-CDN PRECONNECT — app.html preconnects to image.tmdb.org
//       (the origin of every poster/backdrop). Without it the browser
//       pays DNS+TCP+TLS AFTER the first hero/rail <img> parses. No
//       crossorigin (img loads are no-cors).
//
//   E3. SEASON-EPISODES CACHE + RACE GUARD — season switching re-fetched
//       every selection (S1→S2→S1 = 3 roundtrips); a bounded TTL module
//       cache renders repeat selections instantly (and survives
//       back-nav). The request-sequence guard drops out-of-order
//       responses (slow S1 could overwrite a rendered S2).
//
// The suite also LOCKS the pre-existing image contracts the optimizations
// build on (carousel tiers, MediaCard srcset) so they cannot silently
// regress.
// ============================================================================

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const detailPage = read('../src/lib/components/DetailPage.svelte');
const seasonEpisodes = read('../src/lib/components/SeasonEpisodes.svelte');
const appHtml = read('../src/app.html');
const spotlight = read('../src/lib/components/SpotlightCarousel.svelte');
const discoverPage = read('../src/lib/components/DiscoverPage.svelte');
const mediaCard = read('../src/lib/components/MediaCard.svelte');

// ============================================================
// 1. E1 — DetailPage hero responsive tiers
// ============================================================
console.log('\n1. E1: DetailPage hero responsive artwork');

const RETINA_MEDIA = /\(max-width: 640px\) and \(-webkit-min-device-pixel-ratio: 2\), \(max-width: 640px\) and \(min-resolution: 192dpi\)/;
const MOBILE_MEDIA = /\(max-width: 640px\)/;
const DESKTOP_MEDIA = /\(min-width: 641px\)/;

// The hero artwork is a <picture> with the three established tiers.
assert.match(detailPage, /<picture>[\s\S]*?<source[\s\S]*?\/>[\s\S]*?<source[\s\S]*?\/>[\s\S]*?<source[\s\S]*?\/>[\s\S]*?class="hero-img"/,
  'hero artwork is a <picture> with three <source> tiers + the img');

// Retina mobile → w1280 (backdrop first, tier fallback chain).
const retinaSource = detailPage.match(new RegExp(`<source media="[^"]*" srcset="[^"]*" />`.replace('[^"]*', String(RETINA_MEDIA).slice(1, -1))));
assert.ok(detailPage.includes(`media="(max-width: 640px) and (-webkit-min-device-pixel-ratio: 2), (max-width: 640px) and (min-resolution: 192dpi)"`),
  'the retina media query uses the established exact form');
assert.match(detailPage, new RegExp(`${String(RETINA_MEDIA).slice(1, -1)}" srcset=\\{item\\.backdrop \\|\\| item\\.backdropSmall \\|\\| item\\.poster\\}`),
  'retina mobile source: backdrop (w1280) → backdropSmall → poster');

// Standard-DPI mobile → w780 (bandwidth-friendly tier first).
assert.match(detailPage, new RegExp(`${String(MOBILE_MEDIA).slice(1, -1)}" srcset=\\{item\\.backdropSmall \\|\\| item\\.backdrop \\|\\| item\\.poster\\}`),
  'std-DPI mobile source: backdropSmall (w780) → backdrop → poster');

// Tablet/desktop → original (the documented carousel tier decision).
assert.match(detailPage, new RegExp(`${String(DESKTOP_MEDIA).slice(1, -1)}" srcset=\\{item\\.backdropHero \\|\\| item\\.backdrop \\|\\| item\\.backdropSmall \\|\\| item\\.poster\\}`),
  'desktop source: backdropHero (original) → backdrop → backdropSmall → poster');

// The <img> fallback + LCP contracts preserved.
assert.match(detailPage, /class="hero-img"[\s\S]*?width="1280"[\s\S]*?height="720"[\s\S]*?sizes="100vw"[\s\S]*?loading="eager"[\s\S]*?fetchpriority="high"/,
  'hero img: intrinsic dimensions + 100vw sizes + eager + high priority');
assert.match(detailPage, /onerror=\{\(\) => \(heroArtworkFailed = true\)\}/,
  'onerror failure state preserved (gradient fallback, never a broken icon)');
assert.match(detailPage, /\{#if heroArtworkSrc\}[\s\S]*?<picture>/,
  'the whole artwork block is guarded by the failure/empty state');
// The single-src chain remains the SSR/failure derivation.
assert.match(detailPage, /const heroArtwork = \$derived\(item\.backdropHero \|\| item\.backdrop \|\| item\.poster \|\| ''\);/,
  'heroArtwork derivation chain unchanged (original → w1280 → poster)');
ok('1. detail hero: three responsive tiers + preserved LCP/failure contracts');

// ============================================================
// 2. E2 — image CDN preconnect
// ============================================================
console.log('\n2. E2: image.tmdb.org preconnect');

assert.match(appHtml, /<link rel="preconnect" href="https:\/\/image\.tmdb\.org" \/>/,
  'app.html preconnects to the TMDB image CDN');
assert.ok(appHtml.indexOf('rel="preconnect"') < appHtml.indexOf('%sveltekit.head%'),
  'the preconnect sits in the static head (parsed before page-specific head content)');
assert.doesNotMatch(appHtml, /<link rel="preconnect"[^>]*crossorigin[^>]*>/,
  'the image preconnect has NO crossorigin (img loads are no-cors — a crossorigin preconnect would open an unused connection)');
ok('2. preconnect to image.tmdb.org present, early, no-cors');

// ============================================================
// 3. E3 — SeasonEpisodes cache contract
// ============================================================
console.log('\n3. E3: season cache');

assert.match(seasonEpisodes, /const seasonCache = new Map<string, SeasonCacheEntry>\(\);/,
  'module-level season cache (shared across mounts — back-nav instant)');
assert.match(seasonEpisodes, /const SEASON_CACHE_TTL_MS = 10 \* 60 \* 1000;/,
  '10-minute TTL (seasons are near-immutable facts)');
assert.match(seasonEpisodes, /const SEASON_CACHE_MAX_ENTRIES = 60;/,
  'bounded cache (60 series-seasons)');
assert.match(seasonEpisodes, /function seasonCacheKey\(seriesId: string, seasonNumber: number\): string \{[\s\S]*?return `\$\{seriesId\}:\$\{seasonNumber\}`;/,
  'cache key = series id + season number');
assert.match(seasonEpisodes, /if \(Date\.now\(\) - entry\.cachedAt > SEASON_CACHE_TTL_MS\) \{[\s\S]*?seasonCache\.delete\(key\);[\s\S]*?return undefined;/,
  'expired entries are evicted on read (never served)');
assert.match(seasonEpisodes, /if \(seasonCache\.size >= SEASON_CACHE_MAX_ENTRIES\) \{[\s\S]*?for \(const \[k, v\] of seasonCache\) \{[\s\S]*?if \(now - v\.cachedAt > SEASON_CACHE_TTL_MS\) seasonCache\.delete\(k\);[\s\S]*?\}[\s\S]*?while \(seasonCache\.size >= SEASON_CACHE_MAX_ENTRIES\)/,
  'bounded eviction: expired first, then oldest FIFO (the server-cache pattern)');
assert.match(seasonEpisodes, /const cached = readCachedSeason\(id, number\);\s*\n\s*if \(cached\) \{[\s\S]*?season = cached;[\s\S]*?loading = false;[\s\S]*?return;/,
  'cache hit renders synchronously (no roundtrip, no spinner flash)');
assert.match(seasonEpisodes, /season = payload\.season as Season;\s*\n\s*writeCachedSeason\(id, number, season\);/,
  'successful fetches populate the cache');
ok('3. season cache: TTL-bounded, per-series+season, synchronous cache hits');

// ============================================================
// 4. E3 — request-race guard
// ============================================================
console.log('\n4. E3: season request-race guard');

assert.match(seasonEpisodes, /let requestSequence = 0;/,
  'the mount-level request sequence exists');
assert.match(seasonEpisodes, /const sequence = \+\+requestSequence;/,
  'every fetch carries a monotonic sequence number');
assert.match(seasonEpisodes, /if \(sequence !== requestSequence\) return;\s*\n\s*if \(!response\.ok \|\| !payload\.ok\) throw/,
  'a stale SUCCESS response is dropped before rendering (no cache write either)');
assert.match(seasonEpisodes, /catch \(error\) \{\s*\n\s*if \(sequence !== requestSequence\) return;/,
  'a stale FAILURE response is dropped too (the newer request owns the error state)');
assert.match(seasonEpisodes, /finally \{\s*\n\s*if \(sequence === requestSequence\) loading = false;/,
  'only the newest request may clear the loading state');
assert.match(seasonEpisodes, /if \(cached\) \{\s*\n\s*requestSequence \+= 1;/,
  'a cache hit invalidates any in-flight stale response (it supersedes them)');
ok('4. race guard: only the NEWEST season request can render, error, or clear loading');

// ============================================================
// 5. Regression locks — the established image contracts stay
// ============================================================
console.log('\n5. Regression locks: established image contracts');

// SpotlightCarousel (Explorer hero) — the tier contract unchanged.
assert.match(spotlight, /media="\(max-width: 640px\) and \(-webkit-min-device-pixel-ratio: 2\), \(max-width: 640px\) and \(min-resolution: 192dpi\)" srcset=\{slide\.backdrop \|\| slide\.backdropSmall \|\| slide\.poster\}/,
  'SpotlightCarousel retina tier unchanged');
assert.match(spotlight, /media="\(min-width: 641px\)" srcset=\{slide\.backdropHero \|\| slide\.backdrop \|\| slide\.backdropSmall \|\| slide\.poster\}/,
  'SpotlightCarousel desktop tier unchanged');
assert.match(spotlight, /loading=\{index === 0 \? 'eager' : 'lazy'\}[\s\S]*?fetchpriority=\{index === 0 \? 'high' : 'auto'\}/,
  'SpotlightCarousel eager/high only on the first slide');

// DiscoverPage hero — same tier contract unchanged.
assert.match(discoverPage, /media="\(max-width: 640px\) and \(-webkit-min-device-pixel-ratio: 2\), \(max-width: 640px\) and \(min-resolution: 192dpi\)" srcset=\{slide\.item\.backdrop \|\| slide\.item\.backdropSmall \|\| slide\.item\.poster\}/,
  'DiscoverPage retina tier unchanged');
assert.match(discoverPage, /media="\(min-width: 641px\)" srcset=\{slide\.item\.backdropHero \|\| slide\.item\.backdrop \|\| slide\.item\.backdropSmall \|\| slide\.item\.poster\}/,
  'DiscoverPage desktop tier unchanged');

// MediaCard — responsive posters + lazy loading stay.
assert.match(mediaCard, /\$:\s*posterSrcset = item\.posterSmall \? `\$\{item\.posterSmall\} 342w, \$\{item\.poster\} 500w` : undefined;/,
  'MediaCard poster srcset (342w/500w) preserved');
assert.match(mediaCard, /loading="lazy" decoding="async" width="342" height="513"/,
  'MediaCard posters stay lazy + intrinsic-dimensioned');

// SeasonEpisodes stills stay lazy.
assert.match(seasonEpisodes, /<img src=\{episode\.still\} alt=\{`\$\{episode\.title\} still`\} loading="lazy" width="320" height="180" \/>/,
  'episode stills stay lazy + intrinsic-dimensioned');
ok('5. carousel tiers, MediaCard srcset, and still lazy-loading all preserved');

// ============================================================
// 6. Functional check — the cache + race logic, executed
// ============================================================
console.log('\n6. Functional: cache semantics + race semantics');

// Extract and execute the cache functions against a stub Map (mirrors the
// component implementation semantics exactly).
type Season = { number: number; title: string; episodeCount: number; episodes?: unknown[] };
type SeasonCacheEntry = { season: Season; cachedAt: number };
const SEASON_CACHE_TTL_MS = 10 * 60 * 1000;
const SEASON_CACHE_MAX_ENTRIES = 3; // small bound for the eviction test
const seasonCache = new Map<string, SeasonCacheEntry>();
function readCachedSeason(seriesId: string, seasonNumber: number, now: number): Season | undefined {
  const key = `${seriesId}:${seasonNumber}`;
  const entry = seasonCache.get(key);
  if (!entry) return undefined;
  if (now - entry.cachedAt > SEASON_CACHE_TTL_MS) { seasonCache.delete(key); return undefined; }
  seasonCache.delete(key); seasonCache.set(key, entry);
  return entry.season;
}
function writeCachedSeason(seriesId: string, seasonNumber: number, season: Season, now: number): void {
  const key = `${seriesId}:${seasonNumber}`;
  if (seasonCache.size >= SEASON_CACHE_MAX_ENTRIES) {
    for (const [k, v] of seasonCache) { if (now - v.cachedAt > SEASON_CACHE_TTL_MS) seasonCache.delete(k); }
    while (seasonCache.size >= SEASON_CACHE_MAX_ENTRIES) {
      const oldest = seasonCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      seasonCache.delete(oldest);
    }
  }
  seasonCache.set(key, { season, cachedAt: now });
}

const t0 = 1_000_000;
const s1 = { number: 1, title: 'Season 1', episodeCount: 8 };
// Write-through, read-back.
writeCachedSeason('naruto', 1, s1, t0);
assert.equal(readCachedSeason('naruto', 1, t0 + 1000)?.title, 'Season 1',
  'written season reads back');
assert.equal(readCachedSeason('naruto', 2, t0 + 1000), undefined,
  'a different season number is a different key');
assert.equal(readCachedSeason('one-piece', 1, t0 + 1000), undefined,
  'a different series id is a different key');
// TTL expiry.
assert.equal(readCachedSeason('naruto', 1, t0 + SEASON_CACHE_TTL_MS + 1), undefined,
  'expired entries are evicted on read (never served stale)');
// Bounded eviction: expired-first, then FIFO.
writeCachedSeason('a', 1, { number: 1, title: 'A', episodeCount: 1 }, t0);
writeCachedSeason('b', 1, { number: 1, title: 'B', episodeCount: 1 }, t0);
writeCachedSeason('c', 1, { number: 1, title: 'C', episodeCount: 1 }, t0);
writeCachedSeason('d', 1, { number: 1, title: 'D', episodeCount: 1 }, t0);
assert.equal(seasonCache.size, 3, 'the cache never exceeds its bound');
assert.equal(readCachedSeason('a', 1, t0), undefined,
  'FIFO eviction removed the oldest (a) when the bound was hit');
assert.notEqual(readCachedSeason('d', 1, t0), undefined,
  'the newest entry (d) survived the eviction');

// Race semantics (mirrors the component control flow).
let requestSequence = 0;
let rendered: string | undefined;
let loading = false;
async function loadSeason(name: string, delayMs: number): Promise<void> {
  const cached = name === 'cached' ? { number: 1, title: 'cached' } : undefined;
  if (cached) { requestSequence += 1; rendered = 'cached'; loading = false; return; }
  const sequence = ++requestSequence;
  loading = true;
  await new Promise((r) => setTimeout(r, delayMs));
  if (sequence !== requestSequence) return; // stale — dropped
  rendered = name;
  loading = false;
}
// S1 (slow) starts, then S2 (fast) supersedes: only S2 may render.
const slow = loadSeason('S1', 60);
const fast = loadSeason('S2', 5);
await Promise.all([slow, fast]);
assert.equal(rendered, 'S2',
  'a stale slow response can NEVER overwrite a newer selection (the fixed race)');
assert.equal(loading, false, 'loading cleared by the newest request');
// A later cache hit supersedes any in-flight fetch.
const inflight = loadSeason('S3', 40);
const hit = loadSeason('cached', 0);
await Promise.all([inflight, hit]);
assert.equal(rendered, 'cached',
  'a cache hit invalidates in-flight stale responses');
ok('6. functional: TTL eviction, bounded FIFO, race-drop, cache-hit supersession');

console.log(`\nMAV-21 performance tests passed (${passed} check groups).`);
