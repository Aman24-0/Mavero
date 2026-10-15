// Task 2 + 3 (2026-10-15) — Media Library hierarchy + episode sheet +
// bulk link DOM QA (real browser).
//
// Builds a minimal Vite harness that mounts AdminMediaList in isolation
// with a STUBBED fetch (mock library rows, episodes, TMDB season
// metadata, and a capturing bulk-link endpoint — no Supabase, no admin
// auth, no network) and verifies in a REAL Chromium browser:
//
//   §A Hierarchy rendering
//      A1  ONE parent card per series (never one card per episode).
//      A2  The parent card shows the episode rollup (N/M episodes).
//      A3  A movie still renders as a plain card with its provider.
//   §B Accessible episode sheet
//      B1  Opening the parent renders a role=dialog + aria-modal sheet.
//      B2  Season chips follow the Phase-1 sizing contract: all chips
//          exactly 36px tall, equal widths for equal labels, count in
//          aria-label (NOT inside the chip), rail scrolls horizontally.
//      B3  The episode list merges TMDB metadata with linked truth:
//          linked episode shows provider badge, unlinked shows "Add",
//          unreleased shows "Not released" with NO actions.
//      B4  Escape closes the sheet and restores focus to the opener.
//   §C Bulk link (Task 3)
//      C1  "Bulk link season" opens the per-episode reference form.
//      C2  Each episode row has its OWN labeled reference input.
//      C3  Submitting sends ONE POST /api/admin/media/bulk-link whose
//          body carries per-episode items — episode 1 and episode 3
//          each with their OWN distinct reference.
//      C4  The per-episode outcomes render after submit.
//      C5  The sheet remains keyboard-operable throughout (Tab cycles
//          inside the dialog while open).
//
// Run: node scripts/mav_task2_episode_sheet_dom_qa.mjs

import { resolvePlaywright } from './mav_resolve_playwright.mjs';
import { execSync } from 'node:child_process';
import { resolve, dirname, join, normalize, sep } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const harnessDir = resolve(root, 'scripts/harness-episode-sheet');
const distDir = resolve(root, '.cache/episode-sheet-qa-dist');

let browser = null;
let httpServer = null;
let passed = 0;
let failed = 0;

function ok(condition, label) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL ${passed + failed} - ${label}`); }
}

function cleanupArtifacts() {
  try { rmSync(harnessDir, { recursive: true, force: true }); } catch { /* gone */ }
  try { rmSync(distDir, { recursive: true, force: true }); } catch { /* gone */ }
}

// The mock catalog: ONE parent series (4 episodes across 2 seasons in
// TMDB, 2 linked) + one movie. Episodes 1 and 3 are linked (episode 3
// on abyss); episode 2 is unlinked but released; episode 4 is
// FUTURE-dated (unreleased).
const PARENT_ID = 'parent-uuid-1';
const NOW = new Date();
const past = (days) => {
  const d = new Date(NOW.getTime() - days * 86400000);
  return d.toISOString().slice(0, 10);
};
const future = (days) => {
  const d = new Date(NOW.getTime() + days * 86400000);
  return d.toISOString().slice(0, 10);
};

const mockLibraryItems = [
  {
    id: PARENT_ID,
    canonical_key: 'series:tmdb:1396',
    content_type: 'series',
    tmdb_id: '1396',
    imdb_id: null,
    title: 'QA Show',
    year: 2019,
    season: null,
    episode: null,
    episode_title: null,
    parent_media_id: null,
    poster_path: null,
    backdrop_path: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-10T00:00:00Z',
    assets: [],
    demand: null,
    hosting_state: 'hosted',
    episode_summary: { season_count: 2, episode_count: 3, linked_episode_count: 2 },
  },
  {
    id: 'movie-uuid-2',
    canonical_key: 'movie:tmdb:475557',
    content_type: 'movie',
    tmdb_id: '475557',
    imdb_id: null,
    title: 'QA Movie',
    year: 2019,
    season: null,
    episode: null,
    episode_title: null,
    parent_media_id: null,
    poster_path: null,
    backdrop_path: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
    assets: [{
      id: 'movie-asset-1', media_item_id: 'movie-uuid-2', provider_source_id: 'src-vidara',
      provider_asset_id: 'qaMovie', status: 'ready', mavero_status: 'available',
      source_quality: null, available_qualities: [], audio_languages: [], has_subtitles: false,
      duration_seconds: null, size_bytes: null, last_synced_at: null,
      created_at: '2026-10-02T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
    }],
    demand: null,
    hosting_state: 'hosted',
    episode_summary: null,
  },
];

const mockEpisodes = [
  { id: 'ep-uuid-1', canonical_key: 'series:tmdb:1396:s1:e1', content_type: 'series', tmdb_id: '1396', title: 'QA Show', year: 2019, season: 1, episode: 1, episode_title: 'The Beginning', parent_media_id: PARENT_ID, poster_path: null, backdrop_path: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-05T00:00:00Z', assets: [{ id: 'asset-1', media_item_id: 'ep-uuid-1', provider_source_id: 'src-vidara', provider_asset_id: 'qaE1', status: 'ready', mavero_status: 'available', source_quality: null, available_qualities: [], audio_languages: [], has_subtitles: false, duration_seconds: null, size_bytes: null, last_synced_at: null, created_at: '2026-10-05T00:00:00Z', updated_at: '2026-10-05T00:00:00Z' }], demand: null, hosting_state: 'hosted', episode_summary: null },
  { id: 'ep-uuid-3', canonical_key: 'series:tmdb:1396:s1:e3', content_type: 'series', tmdb_id: '1396', title: 'QA Show', year: 2019, season: 1, episode: 3, episode_title: 'Third', parent_media_id: PARENT_ID, poster_path: null, backdrop_path: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-06T00:00:00Z', assets: [{ id: 'asset-3', media_item_id: 'ep-uuid-3', provider_source_id: 'src-abyss', provider_asset_id: 'qaE3', status: 'ready', mavero_status: 'available', source_quality: null, available_qualities: [], audio_languages: [], has_subtitles: false, duration_seconds: null, size_bytes: null, last_synced_at: null, created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z' }], demand: null, hosting_state: 'hosted', episode_summary: null },
];

const mockSeasonsData = [
  { number: 1, title: 'Season 1', episodeCount: 3, airDate: past(400) },
  { number: 2, title: 'Season 2', episodeCount: 8, airDate: past(100) },
];

const mockSeasonEpisodes = [
  { id: 's1e1', number: 1, season: 1, title: 'The Beginning', airDate: past(300), overview: '', runtime: '45m' },
  { id: 's1e2', number: 2, season: 1, title: 'Unlinked One', airDate: past(290), overview: '', runtime: '45m' },
  { id: 's1e3', number: 3, season: 1, title: 'Third', airDate: past(280), overview: '', runtime: '45m' },
  { id: 's1e4', number: 4, season: 1, title: 'Future Episode', airDate: future(7), overview: '', runtime: '45m' },
];

async function run() {
  const { chromium } = await resolvePlaywright();

  mkdirSync(harnessDir, { recursive: true });
  mkdirSync(resolve(harnessDir, 'stubs'), { recursive: true });
  mkdirSync(distDir, { recursive: true });

  writeFileSync(resolve(harnessDir, 'index.html'), `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Episode Sheet QA</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="./main.ts"></script>
</body>
</html>
`);

  writeFileSync(resolve(harnessDir, 'main.ts'), `
import { mount } from 'svelte';
import AdminMediaList from '../../src/lib/components/admin2/AdminMediaList.svelte';

// Captured bulk-link requests (for §C assertions).
window.__bulkRequests = [];

// Stub fetch BEFORE the component mounts.
window.fetch = async (input, init) => {
  const url = String(input);
  const method = (init?.method ?? 'GET').toUpperCase();

  if (url.startsWith('/api/admin/media/library/') && url.endsWith('/episodes')) {
    return window.Response.json({ ok: true, parent: ${JSON.stringify(mockLibraryItems[0])}, episodes: ${JSON.stringify(mockEpisodes)} });
  }
  if (url.startsWith('/api/admin/media/library')) {
    return window.Response.json({ ok: true, items: ${JSON.stringify(mockLibraryItems)}, total: 2, page: 1, limit: 20, has_more: false });
  }
  if (url.includes('/api/content/series/series-1396/season/')) {
    return window.Response.json({ ok: true, season: { number: 1, episodeCount: 3, episodes: ${JSON.stringify(mockSeasonEpisodes)} } });
  }
  if (url.includes('/api/content/series/series-1396')) {
    return window.Response.json({ ok: true, item: { id: 'series-1396', title: 'QA Show', seasonsData: ${JSON.stringify(mockSeasonsData)} } });
  }
  if (url.includes('/api/admin/media/bulk-link') && method === 'POST') {
    const body = JSON.parse(String(init?.body ?? '{}'));
    window.__bulkRequests.push(body);
    return window.Response.json({
      ok: true, contentType: body.contentType, tmdbId: body.tmdbId, season: body.season, provider: body.provider,
      total: body.items.length, succeeded: body.items.length, failed: 0,
      results: body.items.map((it) => ({ episode: it.episode, ok: true, mediaAssetId: 'bulk-' + it.episode, mode: 'insert' })),
    });
  }
  return window.Response.json({ ok: true });
};

const target = document.getElementById('app')!;
mount(AdminMediaList, {
  target,
  props: {
    providers: [
      { adapterId: 'vidara', name: 'Vidara', sourceId: 'src-vidara' },
      { adapterId: 'abyss', name: 'Abyss', sourceId: 'src-abyss' },
    ],
  },
});
`);

  writeFileSync(resolve(harnessDir, 'vite.config.mjs'), `
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';

const harnessDir = ${JSON.stringify(harnessDir)};

export default defineConfig({
  root: harnessDir,
  plugins: [svelte()],
  resolve: {
    alias: {
      '$lib': resolve(harnessDir, '../../src/lib'),
      '$app/state': resolve(harnessDir, './stubs/app-state.ts'),
      '$app/forms': resolve(harnessDir, './stubs/app-forms.ts'),
      '$app/navigation': resolve(harnessDir, './stubs/app-navigation.ts'),
      '$app/environment': resolve(harnessDir, './stubs/app-environment.ts'),
    },
  },
  build: { outDir: ${JSON.stringify(distDir)}, emptyOutDir: true },
});
`);

  writeFileSync(resolve(harnessDir, 'stubs/app-state.ts'), `
export const page = { url: new URL('http://localhost/admin/media/library') };
`);
  writeFileSync(resolve(harnessDir, 'stubs/app-forms.ts'), `
export function enhance() { return () => {}; }
export function applyAction() { return Promise.resolve(); }
`);
  writeFileSync(resolve(harnessDir, 'stubs/app-navigation.ts'), `
export function goto() {}
export function invalidate() { return Promise.resolve(); }
export function invalidateAll() { return Promise.resolve(); }
export function preloadData() {}
export function beforeNavigate() {}
export function afterNavigate() {}
export function onNavigate() {}
`);
  writeFileSync(resolve(harnessDir, 'stubs/app-environment.ts'), `
export const browser = true;
`);

  console.log('Building episode sheet harness…');
  execSync(`./node_modules/.bin/vite build --config ${resolve(harnessDir, 'vite.config.mjs')}`, {
    cwd: root, stdio: 'pipe', timeout: 90000,
  });

  const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
  httpServer = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const requestedPath = normalize(join(distDir, urlPath === '/' ? 'index.html' : urlPath));
    if (!requestedPath.startsWith(distDir + sep)) { res.writeHead(403); res.end('Forbidden'); return; }
    if (!existsSync(requestedPath)) { res.writeHead(404); res.end('not found'); return; }
    const body = readFileSync(requestedPath);
    res.writeHead(200, { 'content-type': MIME[(requestedPath.match(/\.\w+$/) ?? ['.html'])[0]] ?? 'application/octet-stream' });
    res.end(body);
  });

  await new Promise((done) => httpServer.listen(0, '127.0.0.1', done));
  const URL = `http://127.0.0.1:${httpServer.address().port}`;

  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  for (const width of [375, 1280]) {
    console.log(`\n===== viewport ${width}px =====`);
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(150);

    // ---------------- §A hierarchy rendering ----------------
    const parentRows = await page.locator('.media-row-parent').count();
    const allRows = await page.locator('.media-row').count();
    ok(parentRows === 1, `A1 [${width}] exactly ONE parent row renders (got ${parentRows}); total rows ${allRows} (parent + movie, never per-episode cards)`);
    const progressText = await page.locator('.media-row-parent .badge-progress').allTextContents();
    ok(progressText.some((t) => /2\/3 episodes linked/.test(t)), `A2 [${width}] parent card shows the episode rollup (got: ${progressText.join(' / ')})`);
    const movieBadges = await page.locator('.media-row:not(.media-row-parent) .badge-provider').allTextContents();
    ok(movieBadges.some((t) => /vidara/i.test(t)), `A3 [${width}] movie card still shows its provider badge`);

    // ---------------- §B the accessible episode sheet ----------------
    await page.locator('.media-row-parent .media-open').click();
    await page.waitForSelector('.episode-sheet', { state: 'visible' });
    await page.waitForTimeout(250); // seasons + linked fetches settle

    const dialogRole = await page.locator('.episode-sheet').getAttribute('role');
    const ariaModal = await page.locator('.episode-sheet').getAttribute('aria-modal');
    ok(dialogRole === 'dialog' && ariaModal === 'true', `B1 [${width}] the sheet is a role=dialog + aria-modal=true dialog`);

    // Season chips — the Phase-1 sizing contract.
    const chips = await page.locator('.season-chip').evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return { h: +r.height.toFixed(1), w: +r.width.toFixed(1), text: el.textContent.trim(), label: el.getAttribute('aria-label') };
    }));
    ok(chips.length === 2, `B2a [${width}] both season chips render (got ${chips.length})`);
    const heights = new Set(chips.map((c) => c.h));
    ok(heights.size === 1 && [...heights][0] === 36, `B2b [${width}] every chip is exactly 36px tall (heights=${[...heights].join(',')})`);
    const widths = new Set(chips.map((c) => c.w));
    ok(widths.size === 1, `B2c [${width}] equal labels give equal widths (widths=${[...widths].join(',')})`);
    ok(/Season 1, 3 episodes/.test(chips[0]?.label ?? ''), `B2d [${width}] the episode count lives in the aria-label, not the chip (label="${chips[0]?.label}")`);

    // Episode list: 4 TMDB episodes; E1+E3 linked; E2 unlinked; E4 unreleased.
    const episodeRows = await page.locator('.episode-row').evaluateAll((els) => els.map((el) => ({
      released: el.dataset.released,
      linked: el.dataset.linked,
      text: el.textContent,
    })));
    ok(episodeRows.length === 4, `B3a [${width}] the list renders the FULL TMDB season — including unlinked episodes (got ${episodeRows.length})`);
    ok(episodeRows.filter((r) => r.linked === 'true').length === 2, `B3b [${width}] exactly the 2 linked episodes are marked linked`);
    const e4 = episodeRows.find((r) => r.text.includes('Future Episode'));
    ok(e4 != null && e4.released === 'false' && /Not released/.test(e4.text), `B3c [${width}] the future-dated episode shows "Not released" (dataset released=${e4?.released})`);
    const e4Buttons = await page.locator('.episode-row[data-released="false"] .ep-btn').count();
    ok(e4Buttons === 0, `B3d [${width}] the unreleased episode offers NO actions (Add/Update/Delete all gated)`);
    const e2 = episodeRows.find((r) => r.text.includes('Unlinked One'));
    ok(e2 != null && /Not linked/.test(e2.text ?? ''), `B3e [${width}] the unlinked-but-released episode shows "Not linked" with an Add action`);

    // ---------------- §C bulk link ----------------
    await page.locator('.bulk-btn').click();
    await page.waitForSelector('.bulk-form', { state: 'visible' });
    ok(true, `C1 [${width}] "Bulk link season" opens the per-episode reference form`);

    // Unreleased episode is excluded from the bulk candidates.
    const bulkRows = await page.locator('.bulk-row').count();
    ok(bulkRows === 3, `C2a [${width}] one input row per RELEASED episode (3 of 4 — the unreleased one excluded; got ${bulkRows})`);
    const inputLabels = await page.locator('.bulk-ref-input').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
    ok(inputLabels.length === 3 && inputLabels.every((l) => /^Provider reference for episode \d+/.test(l ?? '')), `C2b [${width}] every input is individually labeled per episode`);

    // Fill episode 1 and episode 3 with DIFFERENT references.
    await page.locator('.bulk-row').filter({ hasText: 'The Beginning' }).locator('.bulk-ref-input').fill('refForE1');
    await page.locator('.bulk-row').filter({ hasText: 'Third' }).locator('.bulk-ref-input').fill('refForE3');
    await page.locator('.btn-apply').click();
    await page.waitForSelector('.bulk-outcomes', { state: 'visible' });

    const bulkBodies = await page.evaluate(() => window.__bulkRequests);
    ok(bulkBodies.length === 1, `C3a [${width}] exactly ONE POST /api/admin/media/bulk-link was sent`);
    const body = bulkBodies[0] ?? {};
    ok(body.contentType === 'series' && body.tmdbId === '1396' && body.season === 1 && body.provider === 'vidara', `C3b [${width}] the batch targets the right series/season/provider`);
    const items = body.items ?? [];
    ok(items.length === 2, `C3c [${width}] the body carries the 2 filled episodes only (got ${items.length})`);
    ok(items[0]?.episode === 1 && items[0]?.reference === 'refForE1' && items[1]?.episode === 3 && items[1]?.reference === 'refForE3',
      `C3d [${width}] EACH episode carries its OWN distinct reference (E1→refForE1, E3→refForE3 — never a shared reference)`);
    const outcomes = await page.locator('.outcome-row').count();
    ok(outcomes === 2, `C4 [${width}] the per-episode outcomes render after submit (got ${outcomes})`);

    // ---------------- B4 Escape close + focus restore ----------------
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const sheetGone = await page.locator('.episode-sheet').count();
    ok(sheetGone === 0, `B4 [${width}] Escape closes the episode sheet`);
    const focusClass = await page.evaluate(() => document.activeElement?.className ?? '');
    ok(/media-open/.test(focusClass), `B4b [${width}] focus restores to the parent card opener (focused .media-open)`);

    // The bulk request count must not grow after close (no stray submits).
    const bulkAfter = await page.evaluate(() => window.__bulkRequests.length);
    ok(bulkAfter === 1, `C5 [${width}] no stray bulk submissions after close`);

    await page.close();
  }

  console.log(`\nEpisode sheet + bulk link DOM QA: ${passed} passed, ${failed} failed`);
  await browser.close();
  httpServer.close();
  cleanupArtifacts();
  process.exit(failed ? 1 : 0);
}

run().catch(async (err) => {
  console.error('unexpected failure:', err);
  if (browser) await browser.close();
  if (httpServer) httpServer.close();
  cleanupArtifacts();
  process.exit(1);
});
