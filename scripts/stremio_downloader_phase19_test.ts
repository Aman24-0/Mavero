import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchFourKLinks, extractFormat, extractQuality, extractSize, FOURK_API_ORIGIN } from '$lib/server/downloader/fourk-service';
import { MAVERO_DOWNLOADER_PROVIDER_ID, FOURK_DOWNLOADER_PROVIDER_ID } from '$lib/shared/downloader';
import { rewriteMaveroOrigin, rewriteMaveroOrigins, builtinMaveroDownloaderProvider } from '$lib/server/downloader/public-config';

/**
 * Phase 19 test suite — 4K Downloader + Mavero DB-management + UI changes.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function fetcherFor(routes: Record<string, unknown>, calls: string[]): typeof fetch {
  return (async (url: string | URL) => {
    const key = String(url);
    calls.push(key);
    const handler = routes[key] ?? routes['*'];
    if (handler instanceof Response) return handler;
    if (typeof handler === 'function') return (handler as () => Response)();
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// 1. 4K API — correct movie endpoint
// ---------------------------------------------------------------------------

async function section1(): Promise<void> {
  const calls: string[] = [];
  await fetchFourKLinks({ mediaType: 'movie', tmdbId: '123456' }, {
    fetcher: fetcherFor({ 'https://downloads.shegu.st/movie/123456': json({ links: [] }) }, calls),
  });
  ok(calls.length === 1 && calls[0] === 'https://downloads.shegu.st/movie/123456', `1: correct movie endpoint (got ${calls[0]})`);
}

// ---------------------------------------------------------------------------
// 2. 4K API — correct TV endpoint
// ---------------------------------------------------------------------------

async function section2(): Promise<void> {
  const calls: string[] = [];
  await fetchFourKLinks({ mediaType: 'series', tmdbId: '94605', season: 1, episode: 2 }, {
    fetcher: fetcherFor({ 'https://downloads.shegu.st/tv/94605/1/2': json({ links: [] }) }, calls),
  });
  ok(calls.length === 1 && calls[0] === 'https://downloads.shegu.st/tv/94605/1/2', `2: correct TV endpoint (got ${calls[0]})`);
}

// ---------------------------------------------------------------------------
// 3. 4K API — links[] parsing
// ---------------------------------------------------------------------------

async function section3(): Promise<void> {
  const result = await fetchFourKLinks({ mediaType: 'movie', tmdbId: '123' }, {
    fetcher: fetcherFor({
      'https://downloads.shegu.st/movie/123': json({
        links: [
          { name: '4K CINEJOY [FSL Server] [WEB-DL DDP5][16.62 GB]', url: 'https://cdn.example/movie-4k.mkv' },
          { name: '4K CINEJOY [FSL Server] [WEB-DL DDP5 HDR][20.5 GB]', url: 'https://cdn.example/movie-hdr.mkv' },
        ],
      }),
    }, []),
  });
  ok(result.links.length === 2, `3: 2 links parsed (got ${result.links.length})`);
  ok(result.links[0]?.url === 'https://cdn.example/movie-4k.mkv', '3: first link URL preserved verbatim');
  ok(result.links[1]?.url === 'https://cdn.example/movie-hdr.mkv', '3: second link URL preserved verbatim');
}

// ---------------------------------------------------------------------------
// 4. Format extraction — WEB-DL DDP5
// ---------------------------------------------------------------------------

function section4(): void {
  ok(extractFormat('4K CINEJOY [FSL Server] [WEB-DL DDP5][16.62 GB]') === 'WEB-DL DDP5', `4: format = WEB-DL DDP5 (got ${extractFormat('4K CINEJOY [FSL Server] [WEB-DL DDP5][16.62 GB]')})`);
}

// ---------------------------------------------------------------------------
// 5. Format extraction — WEB-DL DDP5 HDR
// ---------------------------------------------------------------------------

function section5(): void {
  ok(extractFormat('4K CINEJOY [FSL Server] [WEB-DL DDP5 HDR][20.5 GB]') === 'WEB-DL DDP5 HDR', `5: format = WEB-DL DDP5 HDR (got ${extractFormat('4K CINEJOY [FSL Server] [WEB-DL DDP5 HDR][20.5 GB]')})`);
}

// ---------------------------------------------------------------------------
// 6. Format extraction — missing/unrecognized → undefined (no fabrication)
// ---------------------------------------------------------------------------

function section6(): void {
  ok(extractFormat('Movie [5.2 GB]') === undefined, '6: no format bracket → undefined (no fabrication)');
  ok(extractFormat('') === undefined, '6: empty name → undefined');
  ok(extractFormat(undefined) === undefined, '6: undefined name → undefined');
}

// ---------------------------------------------------------------------------
// 7. Quality extraction — 2160p
// ---------------------------------------------------------------------------

function section7(): void {
  ok(extractQuality('4K CINEJOY [2160p] [WEB-DL DDP5][16.62 GB]') === '2160p', `7: quality = 2160p (got ${extractQuality('4K CINEJOY [2160p] [WEB-DL DDP5][16.62 GB]')})`);
  ok(extractQuality('Movie [4K] [WEB-DL]') === '2160p', '7: 4K → 2160p');
}

// ---------------------------------------------------------------------------
// 8. Size extraction — 16.62 GB
// ---------------------------------------------------------------------------

function section8(): void {
  ok(extractSize('4K CINEJOY [FSL Server] [WEB-DL DDP5][16.62 GB]') === '16.62 GB', `8: size = 16.62 GB (got ${extractSize('4K CINEJOY [FSL Server] [WEB-DL DDP5][16.62 GB]')})`);
  ok(extractSize('Movie [5 GB]') === '5 GB', '8: size = 5 GB');
}

// ---------------------------------------------------------------------------
// 9. Exact URL behavior — Download + Share use exact returned URL
// ---------------------------------------------------------------------------

function section9(): void {
  const component = read('src/lib/components/FourKDownload.svelte');
  ok(component.includes('href={link.url}'), '9: Download uses href={link.url} (the EXACT returned URL)');
  ok(component.includes('url = link.url'), '9: Share handler binds url = link.url (the EXACT returned URL)');
  ok(component.includes('navigator.share'), '9: Share uses navigator.share');
  ok(!component.includes('/api/proxy') && !component.includes('proxyMediaUrl'), '9: NO proxy machinery');
}

// ---------------------------------------------------------------------------
// 10. 4K is NOT routed through Stremio normalizer
// ---------------------------------------------------------------------------

function section10(): void {
  const serviceSource = read('src/lib/server/downloader/fourk-service.ts');
  ok(!serviceSource.includes('normalizeStremioStreamResponse'), '10: 4K service does NOT use the Stremio normalizer');
  ok(!serviceSource.includes('stream-normalize'), '10: 4K service does NOT import stream-normalize');
  ok(serviceSource.includes('downloads.shegu.st'), '10: 4K service uses the fixed downloads.shegu.st origin');
}

// ---------------------------------------------------------------------------
// 11. 4K appears in downloader selector (DB-managed)
// ---------------------------------------------------------------------------

function section11(): void {
  const migration = read('supabase/migrations/20260920000000_phase19_mavero_4k_downloaders.sql');
  ok(migration.includes("'4k-downloader'"), '11: 4K Downloader is seeded in the migration');
  ok(migration.includes("'4K Downloader'"), '11: 4K Downloader name is seeded');
  ok(migration.includes('on conflict (slug) do nothing'), '11: migration is idempotent');
}

// ---------------------------------------------------------------------------
// 12. Mavero is DB-managed (migration)
// ---------------------------------------------------------------------------

function section12(): void {
  const migration = read('supabase/migrations/20260920000000_phase19_mavero_4k_downloaders.sql');
  ok(migration.includes("'mavero-downloader'"), '12: Mavero Downloader is seeded in the migration');
  ok(migration.includes("'Mavero Downloader'"), '12: Mavero Downloader name is seeded');
  // The existing five providers are NOT touched.
  ok(!migration.includes("'02movie'"), '12: 02Movie is NOT touched by the migration');
  ok(!migration.includes("'vidvault'"), '12: VidVault is NOT touched');
  ok(!migration.includes("'cineverse'"), '12: Cineverse is NOT touched');
}

// ---------------------------------------------------------------------------
// 13. Mavero origin rewrite (DB stores mavero.local, config rewrites to origin)
// ---------------------------------------------------------------------------

function section13(): void {
  const rewritten = rewriteMaveroOrigins(
    { version: 1, updatedAt: 'now', providers: [builtinMaveroDownloaderProvider('https://mavero.local')] },
    'https://mavero.app',
  );
  const mavero = rewritten.providers.find((p) => p.slug === 'mavero-downloader');
  ok(mavero?.movieUrlTemplate === 'https://mavero.app/watch/mavero-downloader/movie/{tmdbId}', `13: movieUrlTemplate rewritten to origin (got ${mavero?.movieUrlTemplate})`);
  ok(mavero?.tvUrlTemplate === 'https://mavero.app/watch/mavero-downloader/tv/{tmdbId}/{season}/{episode}', `13: tvUrlTemplate rewritten to origin (got ${mavero?.tvUrlTemplate})`);
}

// ---------------------------------------------------------------------------
// 14. Config endpoint uses rewriteMaveroOrigins (NOT withMaveroDownloaderProvider)
// ---------------------------------------------------------------------------

function section14(): void {
  const routeSource = read('src/routes/api/downloader/config/+server.ts');
  ok(routeSource.includes('rewriteMaveroOrigins'), '14: config endpoint calls rewriteMaveroOrigins');
  ok(!routeSource.includes('withMaveroDownloaderProvider'), '14: config endpoint does NOT call withMaveroDownloaderProvider (Mavero is DB-managed)');
}

// ---------------------------------------------------------------------------
// 15. Download sheet header — "Mutiny", NOT "Download Mutiny"
// ---------------------------------------------------------------------------

function section15(): void {
  const component = read('src/lib/components/DownloadSheet.svelte');
  ok(component.includes("sheetTitle = title || 'Download'"), '15: sheetTitle = title (NOT "Download " + title)');
  ok(!component.includes('`Download ${title}`'), '15: NO "Download ${title}" concatenation');
}

// ---------------------------------------------------------------------------
// 16. Suggested apps labels — "1DM+ Downloader" + "MPV Player"
// ---------------------------------------------------------------------------

function section16(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(component.includes('1DM+ Downloader'), '16: label is "1DM+ Downloader"');
  ok(component.includes('MPV Player'), '16: label is "MPV Player"');
  ok(!component.includes('>1DM+<'), '16: old "1DM+" label is gone');
  ok(!component.includes('>mpv<'), '16: old "mpv" label is gone');
}

// ---------------------------------------------------------------------------
// 17. Filters fill the full available row
// ---------------------------------------------------------------------------

function section17(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  const filtersStyle = component.match(/\.mad-filters\s*\{([^}]*)\}/);
  if (filtersStyle) {
    ok(filtersStyle[1].includes('width: 100%') || filtersStyle[1].includes('width:100%'), '17: mad-filters uses width: 100%');
    ok(filtersStyle[1].includes('display: flex'), '17: mad-filters uses display: flex');
  }
  const filterStyle = component.match(/\.mad-filter\s*\{([^}]*)\}/);
  if (filterStyle) {
    ok(filterStyle[1].includes('flex: 1'), '17: each filter uses flex: 1 (distributes across full width)');
  }
}

// ---------------------------------------------------------------------------
// 18. 4K Downloader recognized by DownloadSheet
// ---------------------------------------------------------------------------

function section18(): void {
  const component = read('src/lib/components/DownloadSheet.svelte');
  ok(component.includes('FOURK_DOWNLOADER_PROVIDER_ID'), '18: DownloadSheet imports FOURK_DOWNLOADER_PROVIDER_ID');
  ok(component.includes('is4kDownloader'), '18: DownloadSheet has is4kDownloader derived flag');
  ok(component.includes('FourKDownload'), '18: DownloadSheet renders the FourKDownload component');
}

// ---------------------------------------------------------------------------
// 19. Mavero cards remain Share-only (no Download/Play/Copy)
// ---------------------------------------------------------------------------

function section19(): void {
  const component = read('src/lib/components/MaveroAddonDownload.svelte');
  ok(!component.includes('downloadAttributesFor'), '19: Mavero has NO Download button');
  ok(!component.includes('Play size='), '19: Mavero has NO Play button');
  ok(!component.includes('copyStreamUrl'), '19: Mavero has NO Copy button');
  ok(component.includes('navigator.share'), '19: Mavero has Share (navigator.share)');
}

// ---------------------------------------------------------------------------
// 20. Existing five downloaders remain intact (migration doesn't touch them)
// ---------------------------------------------------------------------------

function section20(): void {
  const migration = read('supabase/migrations/20260920000000_phase19_mavero_4k_downloaders.sql');
  ok(!migration.includes("'02movie'"), '20: 02Movie NOT touched');
  ok(!migration.includes("'vidvault'"), '20: VidVault NOT touched');
  ok(!migration.includes("'nxsha'"), '20: Nxsha NOT touched');
  ok(!migration.includes("'nhd'"), '20: NHD NOT touched');
  ok(!migration.includes("'cineverse'"), '20: Cineverse NOT touched');
}

// ---------------------------------------------------------------------------
// 21. 4K API security — fixed origin, no generic fetcher
// ---------------------------------------------------------------------------

function section21(): void {
  const serviceSource = read('src/lib/server/downloader/fourk-service.ts');
  ok(serviceSource.includes("FOURK_API_ORIGIN = 'https://downloads.shegu.st'"), '21: fixed origin is hardcoded');
  ok(serviceSource.includes('FOURK_API_TIMEOUT_MS'), '21: timeout is configured');
  ok(serviceSource.includes('FOURK_API_MAX_BYTES'), '21: response size limit is configured');
  ok(serviceSource.includes('AbortController'), '21: AbortController is used for timeout');
  // No media URL is fetched — only the JSON API.
  ok(!serviceSource.includes('fetchStremioStreamResponse'), '21: 4K does NOT use the Stremio fetcher');
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

section4();
section5();
section6();
section7();
section8();
section9();
section10();
section11();
section12();
section13();
section14();
section15();
section16();
section17();
section18();
section19();
section20();
section21();

await section1();
await section2();
await section3();

console.log(`stremio_downloader_phase19_test: ${passed} checks passed (Phase 19: 4K Downloader + Mavero DB-managed + UI changes)`);
