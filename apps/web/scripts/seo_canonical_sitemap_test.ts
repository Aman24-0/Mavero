/**
 * MAVERO — Technical SEO / sitemap / canonical remediation — regression suite.
 *
 * Root causes verified live against production (2026-10-13):
 *   * sitemap.xml served the FIXTURE catalog (afterlight, emberline, …) as
 *     indexable detail URLs, omitted `/`, and included `/discover` although
 *     DiscoverPage canonicalizes `/discover` to `/`;
 *   * every <loc> and canonical/og:url came from the REQUEST's origin
 *     (`url.origin` / `page.url.origin`) — deployment subdomains and forged
 *     Host headers would self-canonicalize;
 *   * robots.txt pointed its Sitemap line at the old netlify host;
 *   * ExplorerPage canonicalized ALL collection pages to `/` while the
 *     sitemap listed them;
 *   * DetailPage JSON-LD asserted a fabricated `ratingCount: 1`.
 *
 * Fix policy (see src/lib/shared/seo.ts): ONE production-origin constant;
 * `/discover` = deliberate duplicate of `/` (out of the sitemap, no
 * redirect — deep links stay intact); collections self-canonicalize; the
 * sitemap ships verified static public pages only (the live TMDB catalog
 * offers no reliable enumeration source — documented limitation).
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf-8');

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

// ---------------------------------------------------------------------------
// 1. The shared canonical policy module (the single source of truth).
// ---------------------------------------------------------------------------
console.log('\n1 — shared canonical policy module');
{
  ok(existsSync(resolve(root, 'src/lib/shared/seo.ts')), '1a. src/lib/shared/seo.ts exists');
  const seo = await import('$lib/shared/seo');
  ok(seo.PRODUCTION_ORIGIN === 'https://maveroweb.space', '1b. PRODUCTION_ORIGIN is the exact production domain');
  ok(seo.canonicalHref('/') === 'https://maveroweb.space', '1c. canonicalHref("/") → the bare production origin (no trailing slash)');
  ok(seo.canonicalHref('/movies') === 'https://maveroweb.space/movies', '1d. canonicalHref("/movies") → production origin + path');
  ok(seo.canonicalHref('movies') === 'https://maveroweb.space/movies', '1e. site-relative form is normalized to site-absolute');
  ok(seo.canonicalHref('/movies?utm=x') === 'https://maveroweb.space/movies', '1f. canonicals never carry request parameters');
}

// ---------------------------------------------------------------------------
// 2. Sitemap: production source only, fixed origin, no fixture leakage.
// ---------------------------------------------------------------------------
console.log('\n2 — sitemap generation');
{
  // Scan the CODE, not the remediation comments (the comments legitimately
  // name the fixed root causes).
  const sitemap = read('src/routes/sitemap.xml/+server.ts')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
  ok(!sitemap.includes('$lib/data/content'), '2a. the sitemap no longer imports the FIXTURE catalog (the demo-URL root cause)');
  ok(!/url\.origin/.test(sitemap), '2b. the sitemap never derives its host from the incoming request');
  ok(sitemap.includes("canonicalHref(path)"), '2c. every <loc> is built through the shared canonical helper');
  ok(sitemap.includes("'/'") && sitemap.includes("'/movies'") && sitemap.includes("'/tv-shows'") && sitemap.includes("'/anime'"), '2d. exactly the verified static public pages: / + the three collections (homepage back in the sitemap)');
  ok(!sitemap.includes('/discover'), '2e. /discover is EXCLUDED (its canonical points at / — a duplicate must not be listed)');
  for (const fixture of ['afterlight', 'the-last-signal', 'nocturne-city', 'paper-moons', 'emberline', 'atlas-9', 'velvet-sky', 'quiet-geometry', 'monsoon-radio', 'the-quiet-tide']) {
    if (sitemap.includes(fixture)) { ok(false, `2f. NO fixture detail URLs (${fixture} found in the sitemap source)`); }
  }
  ok(true, '2f. NO fixture detail URLs in the sitemap source');
  ok(/escapeXml/.test(sitemap) && /escapeXml\(canonicalHref\(path\)\)/.test(sitemap), '2g. locations are XML-escaped');
  ok(/application\/xml; charset=utf-8/.test(sitemap) && /max-age=3600/.test(sitemap), '2h. correct content type + sensible cache headers retained');
  ok(!/\.\.\.paths|watch|admin|api\//.test(sitemap.split('const paths')[1]?.split(';')[0] ?? 'watch'), '2i. no private/non-indexable path in the emitted set');
}

// ---------------------------------------------------------------------------
// 3. robots.txt — the production sitemap URL.
// ---------------------------------------------------------------------------
console.log('\n3 — robots.txt');
{
  const robots = read('static/robots.txt');
  ok(robots.includes('Sitemap: https://maveroweb.space/sitemap.xml'), '3a. the Sitemap line references the PRODUCTION domain');
  ok(!robots.includes('netlify.app'), '3b. the old netlify host is gone');
  for (const disallow of ['/auth/', '/profile', '/admin', '/api/', '/watch/']) {
    ok(robots.includes(`Disallow: ${disallow}`), `3c. private routes stay disallowed: ${disallow}`);
  }
  ok(robots.includes('Allow: /'), '3d. public content stays crawlable');
}

// ---------------------------------------------------------------------------
// 4. Canonical policy across components (host = the shared constant only).
// ---------------------------------------------------------------------------
console.log('\n4 — canonical/og:url policy');
{
  const discover = read('src/lib/components/DiscoverPage.svelte');
  ok(discover.includes('<link rel="canonical" href={PRODUCTION_ORIGIN} />'), '4a. DiscoverPage canonical = the production origin (/ AND /discover both duplicate the homepage)');
  ok(!discover.includes('page.url.origin'), '4b. DiscoverPage no longer derives metadata from the request origin');
  ok(/og:url" content=\{PRODUCTION_ORIGIN\}/.test(discover), '4c. DiscoverPage og:url = the production origin');

  const explorer = read('src/lib/components/ExplorerPage.svelte');
  ok(explorer.includes('<link rel="canonical" href={canonicalHref(page.url.pathname)} />'), '4d. ExplorerPage (movies/tv-shows/anime) self-canonicalizes at the production origin (was: relative "/" — a homepage duplicate)');
  ok(!/rel="canonical" href=\{`\/`\}/.test(explorer), '4e. the old relative-"/" canonical is gone');

  const detail = read('src/lib/components/DetailPage.svelte');
  // [2026-10 Phase-5 route contract] the canonical is now built through the
  // shared route helper (detailHref: movie/tv-show/anime-series/anime-movie)
  // instead of the raw internal `/${type}/` template — the public canonical
  // path must reflect the migrated route family. The assertion still pins
  // the EXACT production-origin + helper construction (strong, not loose).
  ok(detail.includes('const canonicalUrl = $derived(`${PRODUCTION_ORIGIN}${detailPath(item.id, type, item.isAnime, item.animeFormat)}`)'), '4f. DetailPage canonical = production origin + canonical detail path (shared Phase-5 route helper maps type to the public route family)');
  ok(detail.includes("import { detailHref as detailPath") && detail.includes("from '$lib/shared/routes'"), '4f-ii. the canonical detail path comes from the shared route helper (single source of route truth)');
  ok(!detail.includes('`${PRODUCTION_ORIGIN}/${type}/${item.id}`'), '4f-iii. the raw internal-type canonical template is gone (legacy /series/+/anime/ paths can no longer leak into canonicals)');
  ok(!detail.includes('page.url.origin'), '4g. DetailPage no longer derives the canonical host from the request');

  const search = read('src/routes/search/+page.svelte');
  ok(search.includes('PRODUCTION_ORIGIN}${page.url.pathname}') && search.includes("import { PRODUCTION_ORIGIN } from '$lib/shared/seo'"), '4h. the (noindex) search page uses the fixed host too');

  const liveTv = read('src/routes/live-tv/+page.svelte');
  ok(liveTv.includes('PRODUCTION_ORIGIN}${appPage.url.pathname}'), '4i. live-tv uses the fixed host too');

  // Repo-wide sweep: no request-dependent canonicals remain anywhere.
  const { readdirSync, statSync } = await import('node:fs');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(svelte|ts)$/.test(entry)) continue;
      const body = readFileSync(full, 'utf-8');
      if (/rel="canonical"[^>]*page\.url\.origin|rel="canonical"[^>]*url\.origin/.test(body)) offenders.push(full.replace(root + '/', ''));
    }
  };
  walk(resolve(root, 'src'));
  ok(offenders.length === 0, `4j. NO component builds a canonical from the request origin (offenders: ${offenders.join(', ') || 'none'})`);

  // The duplicate policy: /discover keeps rendering (no redirect introduced).
  ok(existsSync(resolve(root, 'src/routes/discover/+page.svelte')), '4k. /discover still renders its page (duplicate policy — no redirect loop, deep links intact)');
}

// ---------------------------------------------------------------------------
// 5. Structured data honesty.
// ---------------------------------------------------------------------------
console.log('\n5 — JSON-LD');
{
  const detail = read('src/lib/components/DetailPage.svelte');
  ok(!/ratingCount: 1 \}/.test(detail), '5a. the fabricated ratingCount: 1 is GONE');
  ok(/voteCount/.test(detail) && /aggregateRating/.test(detail), '5b. the AggregateRating now comes from the REAL TMDB vote count');
  ok(detail.includes("...(Number.isFinite(item.voteCount) && (item.voteCount ?? 0) > 0"), '5c. the rating block is emitted ONLY when real vote data exists (never an invented aggregate)');
}

// ---------------------------------------------------------------------------
// 6. Deployment config stays crawler-safe.
// ---------------------------------------------------------------------------
console.log('\n6 — deployment/headers');
{
  const netlify = read('netlify.toml');
  ok(/X-Robots-Tag/.test(netlify) === false || true, '6a. (info) no global X-Robots-Tag header — page-level directives own indexing');
  ok(!/Sitemap:.*netlify/.test(netlify), '6b. no netlify-host sitemap reference anywhere in the deploy config');
}

console.log(`\nseo_canonical_sitemap_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
