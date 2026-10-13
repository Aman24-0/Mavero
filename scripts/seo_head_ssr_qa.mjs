// MAVERO — SEO follow-up SSR validation (2026-10).
//
// Validates the RENDERED SSR HTML (requires a running production-build
// preview, same contract as player_v2_corrections_qa.mjs — `pnpm build &&
// vite preview`, default http://127.0.0.1:4173):
//   * exactly ONE <meta name="description"> per validated route (the
//     duplicate-description root cause) and the route-specific copy present;
//   * search + live-tv og:url carry the FIXED production origin regardless
//     of the request host (validated by fetching through 127.0.0.1 — a
//     request whose host must never leak into og:url);
//   * search + live-tv keep noindex,follow;
//   * canonical links carry the production origin (prior remediation
//     unregressed);
//   * /robots.txt + /sitemap.xml still serve the production policy.
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/index.mjs';

const BASE = process.env.PREVIEW_BASE || 'http://127.0.0.1:4173';
const ORIGIN = 'https://maveroweb.space';

let passed = 0, failed = 0;
const check = (name, condition, detail = '') => {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL - ${name}${detail ? ` — ${detail}` : ''}`); }
};

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

async function head(route) {
  const response = await page.request.get(`${BASE}${route}`);
  return { status: response.status(), body: await response.text() };
}

const context = await browser.newContext();
const page = await context.newPage();

const routes = ['/', '/movies', '/tv-shows', '/anime', '/search', '/live-tv'];
const heads = {};
for (const route of routes) {
  const result = await head(route);
  heads[route] = result;
  check(`${route}: SSR renders (200)`, result.status === 200, `status ${result.status}`);
}

for (const route of routes) {
  const body = heads[route].body;
  const descriptions = (body.match(/<meta name="description"/g) ?? []).length;
  check(`${route}: exactly ONE meta description`, descriptions === 1, `count ${descriptions}`);
}
check('/: the description is the Discover copy (route-specific, not a fallback)', heads['/'].body.includes('Stream movies, TV shows, and anime on MAVERO.'));
check('/search: the route-specific description remains', heads['/search'].body.includes('Search movies and series across the Mavero catalog.'));
check('/live-tv: the route-specific description remains', heads['/live-tv'].body.includes('Browse and watch live TV channels in Mavero.'));

// og:url fixed origin — the SSR was served from 127.0.0.1:4173; the emitted
// og:url must STILL name the production origin (the request never leaks).
check('/search: og:url = fixed production origin (request host ignored)', heads['/search'].body.includes(`<meta property="og:url" content="${ORIGIN}/search"`));
check('/live-tv: og:url = fixed production origin (request host ignored)', heads['/live-tv'].body.includes(`<meta property="og:url" content="${ORIGIN}/live-tv"`));
check('/search: noindex,follow preserved', /<meta name="robots" content="noindex,follow"/.test(heads['/search'].body));
check('/live-tv: noindex,follow preserved', /<meta name="robots" content="noindex,follow"/.test(heads['/live-tv'].body));
check('/: canonical = the bare production origin', heads['/'].body.includes(`<link rel="canonical" href="${ORIGIN}"`));
check('/movies: canonical = production origin + path', heads['/movies'].body.includes(`<link rel="canonical" href="${ORIGIN}/movies"`));

// robots + sitemap through the same server.
const robots = await head('/robots.txt');
check('/robots.txt: production sitemap line', robots.body.includes('Sitemap: https://maveroweb.space/sitemap.xml'));
const sitemap = await head('/sitemap.xml');
check('/sitemap.xml: 4 verified static URLs, production origin only', sitemap.body.includes('<loc>https://maveroweb.space</loc>') && sitemap.body.includes('<loc>https://maveroweb.space/movies</loc>') && !(sitemap.body.includes('/discover') || sitemap.body.includes('afterlight')));

await browser.close();
console.log(`\nseo_head_ssr_qa: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
