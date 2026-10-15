/**
 * MAV-FOCUSED Issue 1 (2026-10) — dummy routes & sitemap URLs regression suite.
 *
 * Confirmed root cause (verified at HEAD before this fix):
 *   - `getDetail()` in `src/lib/server/content/service.ts` had a
 *     `NOT_FOUND` → `fixtureDetail()` fallback. So `/movie/afterlight`
 *     (and every other fixture slug from `$lib/data/content`) rendered a
 *     real-looking detail page (cast, providers, recommendations) instead
 *     of the route's existing 404 — even though the production sitemap
 *     was already clean (commit b3374e1).
 *   - `getSeriesSeason()` synthesised a fabricated season with placeholder
 *     episodes (`Episode 3`, `Unknown` runtime) for any non-numeric slug.
 *   - `discover()`, `collection()`, `popular()` and `search()` all fell
 *     back to fixtures on `UPSTREAM_ERROR` / `RATE_LIMITED` /
 *     `INVALID_RESPONSE`, leaking the demo catalog onto the Discover
 *     homepage and search results during a TMDB hiccup.
 *
 * Behaviour after the fix:
 *   - In production (TMDB credentials present): `/movie/afterlight`,
 *     `/series/nocturne-city`, `/anime/paper-moons`, … all 404 at the
 *     `getDetail` gate (the SSR `+page.server.ts` already throws 404 on
 *     any thrown service error).
 *   - The season endpoint 404s for fixture slugs in production.
 *   - `canFallback` is now `code === 'CONFIG_MISSING'` only — production
 *     TMDB failures propagate (rails render empty, search returns empty)
 *     instead of leaking fixtures.
 *   - Local-dev path (no TMDB credentials) keeps the existing fixture
 *     behaviour so a developer can still exercise the UI.
 *   - The sitemap itself stays clean (regression-pinned by
 *     seo_canonical_sitemap_test.ts).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf-8');
/** Source with line comments stripped — assertions must never match prose. */
const readCode = (p: string) => read(p)
  .split('\n')
  .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
  .join('\n');

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

console.log('\n1 — service.ts: NOT_FOUND → fixture fallback is GONE');
{
  const service = readCode('src/lib/server/content/service.ts');
  const detailFn = service.slice(service.indexOf('export async function getDetail'), service.indexOf('export async function getDetail') + 2400);

  // The new gate: the catch block must NOT include NOT_FOUND in its
  // fixture-fallback condition.
  ok(!/code\s*===\s*['"]NOT_FOUND['"]/.test(detailFn), '1a. getDetail catch no longer falls back on NOT_FOUND');
  // The new gate: only CONFIG_MISSING is allowed to fall back to fixtures.
  ok(/code\s*===\s*['"]CONFIG_MISSING['"]/.test(detailFn), '1b. getDetail catch falls back ONLY on CONFIG_MISSING (local dev)');
  // The fixture lookup is gated behind that CONFIG_MISSING check (not unconditional).
  const catchStart = detailFn.indexOf('} catch (error) {');
  const fixtureLookup = detailFn.indexOf('fixtureDetail(type, id)', catchStart);
  const configMissingCheck = detailFn.indexOf("code === 'CONFIG_MISSING'", catchStart);
  ok(fixtureLookup > configMissingCheck && fixtureLookup > -1, '1c. fixtureDetail is only invoked after the CONFIG_MISSING gate (never on NOT_FOUND)');
}

console.log('\n2 — service.ts: getSeriesSeason no longer fabricates seasons for fixture slugs');
{
  const service = readCode('src/lib/server/content/service.ts');
  const seasonFn = service.slice(service.indexOf('export async function getSeriesSeason'), service.indexOf('export async function getDetail'));

  // In production (TMDB credentials present) the function must throw NOT_FOUND
  // for fixture slugs — it must not return the fabricated `Episode N` array.
  ok(/TMDB_READ_ACCESS_TOKEN\s*\|\|\s*env\.TMDB_API_KEY/.test(seasonFn), '2a. fixture-slug path is gated behind a TMDB-credentials check');
  ok(/code:\s*['"]NOT_FOUND['"]/.test(seasonFn), '2b. fixture slugs throw NOT_FOUND when TMDB credentials are present');
  // The fixture fabrication still exists for the local-dev path (no credentials).
  ok(/fixture\?\.episodes\s*\?\?\s*8/.test(seasonFn), '2c. fixture fallback retained for the local-dev (no-TMDB) path');
}

console.log('\n3 — service.ts: canFallback is CONFIG_MISSING only (no production fixture leak)');
{
  const service = readCode('src/lib/server/content/service.ts');
  const canFallbackFn = service.slice(service.indexOf('function canFallback'), service.indexOf('function canFallback') + 400);
  ok(!/UPSTREAM_ERROR|RATE_LIMITED|INVALID_RESPONSE/.test(canFallbackFn), '3a. canFallback no longer includes UPSTREAM_ERROR / RATE_LIMITED / INVALID_RESPONSE');
  // canFallback delegates to isMissingConfig (which checks CONFIG_MISSING).
  // The CONFIG_MISSING constant lives in isMissingConfig — verified separately.
  const isMissingConfigFn = service.slice(service.indexOf('function isMissingConfig'), service.indexOf('function isMissingConfig') + 200);
  ok(/CONFIG_MISSING/.test(isMissingConfigFn), '3b. isMissingConfig still checks CONFIG_MISSING (the local-dev path is preserved)');
  // The function body should be the one-line `return isMissingConfig(error)` form.
  ok(/return\s+isMissingConfig\(error\)/.test(canFallbackFn), '3c. canFallback delegates directly to isMissingConfig');
}

console.log('\n4 — sitemap remains clean (regression pin against future reintroduction)');
{
  const sitemap = readCode('src/routes/sitemap.xml/+server.ts');
  ok(!sitemap.includes('$lib/data/content'), '4a. the sitemap never imports the fixture catalog');
  ok(!sitemap.includes('media'), '4b. the sitemap never references the fixture `media` export');
  const fixtureSlugs = ['afterlight', 'the-last-signal', 'nocturne-city', 'paper-moons', 'emberline', 'atlas-9', 'velvet-sky', 'quiet-geometry', 'monsoon-radio', 'the-quiet-tide'];
  for (const slug of fixtureSlugs) {
    ok(!sitemap.includes(slug), `4c. sitemap does NOT emit fixture slug "${slug}"`);
  }
  // The verified static public pages remain.
  ok(sitemap.includes("'/'") && sitemap.includes("'/movies'") && sitemap.includes("'/tv-shows'") && sitemap.includes("'/anime'"), '4d. the verified static public pages are still emitted');
}

console.log('\n5 — detail page routes still 404 on thrown service errors (existing behaviour preserved)');
{
  // The SSR `+page.server.ts` files catch any thrown service error and convert
  // it to a 404. This is what makes `/movie/afterlight` 404 in production
  // after the `getDetail` fix above (TMDB returns NOT_FOUND, service throws,
  // route catches → 404).
  // [2026-10 Phase-5 route contract] series/anime detail MARKUP lives at the
  // canonical /tv-show/[id] and /anime-series/[id] routes — legacy /series/[id]
  // and /anime/[id] are 308 redirect shells (verified), so the 404 handler is
  // pinned on the canonical routes.
  for (const route of ['movie', 'tv-show', 'anime-series']) {
    const server = read(`src/routes/${route}/[id]/+page.server.ts`);
    ok(/throw error\(404,/.test(server), `5a. /${route}/[id]/+page.server.ts throws 404 on a service error (the existing 404 handler is preserved)`);
  }
}

console.log('\n6 — fixture data file is untouched (legitimate dev path preserved)');
{
  // We do NOT delete the fixture catalog — it remains the local-dev fallback
  // for CONFIG_MISSING. The fix closes the PRODUCTION leak, not the dev path.
  const fixtureCatalog = read('src/lib/data/content.ts');
  ok(fixtureCatalog.includes("id: 'afterlight'") && fixtureCatalog.includes("id: 'paper-moons'"), '6a. the fixture catalog is intact for the local-dev path');
}

console.log(`\nmav_focused_issue1_dummy_routes_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
