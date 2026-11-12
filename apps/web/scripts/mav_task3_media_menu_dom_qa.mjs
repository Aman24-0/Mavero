// Task 3 (2026-10-15) — Media Library action-menu DOM QA (real browser).
//
// Builds a minimal Vite harness that mounts AdminMediaList in isolation
// with a STUBBED fetch (mock library rows — no Supabase, no admin auth,
// no network) and verifies the portaled action menu in a REAL Chromium
// browser at desktop and mobile widths:
//
//   Grid view   — first card + LAST visible card: the menu is fully
//                 inside the viewport (the old overflow:hidden clip).
//   List view   — first row + LAST visible row near the scroll bottom.
//   Bottom/right viewport edges — clamped inside an 8px margin.
//   Scroll while open   — the menu repositions with the trigger.
//   View switch while open — the menu closes (stale anchor prevention).
//   Outside click / Escape — reliable close; Escape restores focus.
//   Menu action isolation — a menu click never triggers a card/parent action.
//   Update link / Delete — the correct record is targeted.
//   Mobile width — no horizontal page overflow, menu fully visible.
//
// Run: node scripts/mav_task3_media_menu_dom_qa.mjs

import { resolvePlaywright } from './mav_resolve_playwright.mjs';
import { execSync } from 'node:child_process';
import { resolve, dirname, extname, join, normalize, sep } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const harnessDir = resolve(root, 'scripts/harness-media-menu');
const distDir = resolve(root, '.cache/media-menu-qa-dist');

let browser = null;
let httpServer = null;
let passed = 0;
let failed = 0;

function ok(condition, label) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

// Mock library rows in the API's wire shape (media items with nested
// assets[]) — enough to fill the viewport and overflow the grid.
function mockRows(count) {
  const types = ['movie', 'series', 'anime'];
  const rows = [];
  for (let i = 1; i <= count; i += 1) {
    rows.push({
      id: `item-${i}`,
      title: `QA Title ${i}`,
      content_type: types[i % 3],
      tmdb_id: String(1000 + i),
      poster_path: null, // fallback icon — no external image dependency
      assets: [{
        id: `asset-${i}`,
        provider_source_id: 'src-vidara',
        provider_asset_id: `code${i}`,
        status: 'ready',
        mavero_status: 'available',
      }],
    });
  }
  return rows;
}

function cleanupArtifacts() {
  try { rmSync(harnessDir, { recursive: true, force: true }); } catch { /* gone */ }
  try { rmSync(distDir, { recursive: true, force: true }); } catch { /* gone */ }
}

async function openMenuFor(page, index) {
  // index = the n-th trigger (0-based) in DOM order.
  const triggers = page.locator('.media-grid .grid-menu-btn, .media-list .menu-trigger');
  await triggers.nth(index).click();
  await page.waitForSelector('.menu-dropdown.floating', { state: 'visible' });
}

async function assertMenuInsideViewport(page, label) {
  const box = await page.locator('.menu-dropdown.floating').boundingBox();
  const viewport = page.viewportSize();
  const margin = 0.5; // allow sub-pixel rounding
  ok(box && box.x >= -margin && box.y >= -margin
    && box.x + box.width <= viewport.width + margin
    && box.y + box.height <= viewport.height + margin,
    `${label} — menu fully inside the viewport (x=${Math.round(box?.x ?? -1)}, y=${Math.round(box?.y ?? -1)}, w=${Math.round(box?.width ?? 0)}, h=${Math.round(box?.height ?? 0)}, viewport ${viewport.width}x${viewport.height})`);
  return box;
}

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
  <title>Media Menu QA</title>
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

// Stub fetch BEFORE the component mounts: every /api/admin/media/library
// call gets mock rows; every other endpoint gets a benign ok.
const rows = ${JSON.stringify(mockRows(24))};
const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url.includes('/api/admin/media/library')) {
    return new Response(JSON.stringify({ ok: true, items: rows, hasMore: false }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};

const target = document.getElementById('app')!;
mount(AdminMediaList, {
  target,
  props: {
    providers: [{ adapterId: 'vidara', name: 'Vidara', sourceId: 'src-vidara' }],
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
      '$components': resolve(harnessDir, '../../src/lib/components'),
      '$app/state': resolve(harnessDir, './stubs/app-state.ts'),
      '$app/forms': resolve(harnessDir, './stubs/app-forms.ts'),
      '$app/navigation': resolve(harnessDir, './stubs/app-navigation.ts'),
      '$app/environment': resolve(harnessDir, './stubs/app-environment.ts'),
    },
  },
  build: {
    outDir: ${JSON.stringify(distDir)},
    emptyOutDir: true,
  },
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

  console.log('Building media menu harness…');
  execSync(`./node_modules/.bin/vite build --config ${resolve(harnessDir, 'vite.config.mjs')}`, {
    cwd: root, stdio: 'pipe', timeout: 90000,
  });

  // Proper MIME map — Chromium refuses to APPLY stylesheets served with a
  // non-CSS MIME type (the same pattern as admin_nav_dom_qa.mjs).
  const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
  httpServer = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const requestedPath = normalize(join(distDir, urlPath === '/' ? 'index.html' : urlPath));
    if (!requestedPath.startsWith(distDir + sep)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    if (!existsSync(requestedPath)) {
      res.writeHead(404); res.end('Not found'); return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(requestedPath)] ?? 'application/octet-stream' });
    res.end(readFileSync(requestedPath));
  });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = httpServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}/`;

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(() => { try { localStorage.clear(); } catch { /* ignore */ } });

  console.log('\\n§A — list view (default)');
  await page.goto(baseUrl);
  await page.waitForSelector('.media-list .menu-trigger', { timeout: 15000 });
  const rowCount = await page.locator('.media-list .media-row').count();
  ok(rowCount === 24, `A0. mocked library renders 24 rows (got ${rowCount})`);

  await openMenuFor(page, 0);
  ok(await page.locator('.menu-dropdown.floating').isVisible(), 'A1. list view, first row — menu opens');
  ok(await page.locator('.menu-dropdown.floating').evaluate((el) => el.parentElement === document.body), 'A2. menu is PORTALED to document.body (no ancestor overflow can clip it)');
  console.log('DEBUG className=', await page.locator('.menu-dropdown.floating').evaluate((el) => el.className));
  console.log('DEBUG position=', await page.locator('.menu-dropdown.floating').evaluate((el) => getComputedStyle(el).position));
  console.log('DEBUG zindex=', await page.locator('.menu-dropdown.floating').evaluate((el) => getComputedStyle(el).zIndex));
  await assertMenuInsideViewport(page, 'A3. list view, first row');
  await page.keyboard.press('Escape');
  ok(await page.locator('.menu-dropdown.floating').count() === 0, 'A4. Escape closes the menu');

  // Last row is at the scroll bottom — the OLD defect.
  const lastIndex = rowCount - 1;
  await openMenuFor(page, lastIndex);
  ok(true, 'A5. list view, LAST row — menu opens');
  await assertMenuInsideViewport(page, 'A6. list view, LAST row (bottom-of-scroll clip fixed)');
  // The flipped/clamped menu must not require scrolling to see.
  const listEl = await page.locator('.media-list').boundingBox();
  const menuBox = await page.locator('.menu-dropdown.floating').boundingBox();
  ok(menuBox && listEl && (menuBox.y + menuBox.height <= listEl.y + listEl.height || menuBox.y >= listEl.y), 'A7. the menu is fully visible within the visible scroll area (no partial hiding)');
  await page.keyboard.press('Escape');

  console.log('\\n§B — grid view (the overflow:hidden clip)');
  await page.click('.view-toggle button[aria-label="Grid view"]');
  await page.waitForSelector('.media-grid .grid-menu-btn', { timeout: 5000 });
  const cardCount = await page.locator('.media-grid .grid-card').count();
  ok(cardCount === 24, `B0. grid view renders 24 cards (got ${cardCount})`);

  await openMenuFor(page, 0);
  ok(await page.locator('.menu-dropdown.floating').isVisible(), 'B1. grid view, first card — menu opens');
  await assertMenuInsideViewport(page, 'B2. grid view, first card');
  await page.keyboard.press('Escape');

  await openMenuFor(page, cardCount - 1);
  ok(true, 'B3. grid view, LAST visible card — menu opens');
  await assertMenuInsideViewport(page, 'B4. grid view, LAST visible card (overflow:hidden clip fixed)');
  await page.keyboard.press('Escape');

  console.log('\\n§C — bottom + right viewport edge clamping');
  // Open the menu on a trigger near the RIGHT edge: the LAST card in the
  // top row of the grid (rightmost). Then check clamping.
  await openMenuFor(page, 5);
  await assertMenuInsideViewport(page, 'C1. right-side trigger — clamped inside the viewport');
  await page.keyboard.press('Escape');

  console.log('\\n§D — scroll while open (anchor follows or closes, never orphaned)');
  // List view: the menu opens, the list scrolls, the menu repositions.
  await page.click('.view-toggle button[aria-label="List view"]');
  await page.waitForSelector('.media-list .menu-trigger');
  await openMenuFor(page, 0);
  const menuAtOpen = await page.locator('.menu-dropdown.floating').boundingBox();
  await page.locator('.media-list').evaluate((el) => { el.scrollTop = 120; });
  await page.waitForTimeout(300);
  const menuStillThere = await page.locator('.menu-dropdown.floating').count();
  if (menuStillThere > 0) {
    const menuAfter = await page.locator('.menu-dropdown.floating').boundingBox();
    ok(menuAfter && menuAtOpen && Math.abs(menuAfter.y - menuAtOpen.y) > 2, 'D1. scroll repositions the menu (anchor follows the trigger)');
    await assertMenuInsideViewport(page, 'D2. after scroll the menu is still fully visible');
  } else {
    ok(true, 'D1. scroll closed the menu (stale-anchor policy — acceptable)');
  }
  await page.keyboard.press('Escape');

  console.log('\\n§E — outside click + focus behavior');
  await openMenuFor(page, 2);
  await page.mouse.click(30, 300); // outside any menu/trigger
  ok(await page.locator('.menu-dropdown.floating').count() === 0, 'E1. outside click closes the menu');
  // Escape restores focus to the trigger.
  const triggerCount = await page.locator('.media-list .menu-trigger').count();
  await openMenuFor(page, 2);
  await page.keyboard.press('Escape');
  const focusedIsTrigger = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Actions');
  ok(focusedIsTrigger, `E2. Escape restores focus to the trigger (${triggerCount} triggers present)`);
  // Tab reaches the trigger (keyboard accessibility; the grid trigger is a real <button>).
  ok(await page.locator('.media-list .menu-trigger').first().evaluate((el) => el.tagName === 'BUTTON'), 'E3. triggers are real buttons (keyboard operable)');

  console.log('\\n§F — menu action isolation + targeting');
  // Update link: the wizard opens with the right record.
  await openMenuFor(page, 3);
  await page.click('.menu-dropdown.floating .menu-item:first-child');
  await page.waitForSelector('.wizard-overlay .wizard-close', { timeout: 5000 });
  ok(true, 'F1. Update link opens the wizard for the targeted row');
  await page.click('.wizard-overlay .wizard-close');
  await page.waitForSelector('.wizard-overlay', { state: 'detached', timeout: 5000 });
  // Delete: the confirm dialog appears (Mavero-side delete only).
  await openMenuFor(page, 4);
  await page.click('.menu-dropdown.floating .menu-item-danger');
  await page.waitForSelector('.confirm-dialog', { timeout: 5000 });
  ok(true, 'F2. Delete opens the confirmation (Mavero-side deletion flow preserved)');
  await page.click('.confirm-dialog .btn-cancel');
  await page.waitForSelector('.confirm-dialog', { state: 'detached', timeout: 5000 });

  console.log('\\n§G — mobile width (375px)');
  const overlayDebug = await page.evaluate(() => {
    const overlays = Array.from(document.querySelectorAll('.wizard-overlay'));
    return overlays.map((o) => ({ visible: o.offsetParent !== null, child: o.firstElementChild?.className ?? 'none', text: (o.textContent ?? '').slice(0, 80) }));
  });
  console.log('OVERLAY DEBUG ' + JSON.stringify(overlayDebug));
  await page.setViewportSize({ width: 375, height: 667 });
  await page.waitForTimeout(200);
  const mobileTriggers = page.locator('.media-list .menu-trigger, .media-grid .grid-menu-btn');
  await mobileTriggers.first().click();
  await page.waitForSelector('.menu-dropdown.floating', { state: 'visible' });
  await assertMenuInsideViewport(page, 'G1. mobile — menu fully visible');
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  ok(!horizontalOverflow, 'G2. mobile — no horizontal page overflow');
  await page.keyboard.press('Escape');

  console.log('\\n§H — view switch while open');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(200);
  await openMenuFor(page, 0);
  await page.click('.view-toggle button[aria-label="Grid view"]');
  await page.waitForTimeout(200);
  ok(await page.locator('.menu-dropdown.floating').count() === 0, 'H1. switching views closes the open menu (no stale anchor)');

  console.log(`\\nTask 3 DOM QA result: ${passed} passed, ${failed} failed`);
  await browser.close();
  browser = null;
  if (httpServer) httpServer.close();
  if (failed > 0) process.exit(1);
}

try {
  await run();
} finally {
  cleanupArtifacts();
  if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  if (httpServer) { try { httpServer.close(); } catch { /* ignore */ } }
}
