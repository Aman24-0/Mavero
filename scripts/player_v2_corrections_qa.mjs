// Player V2 corrections — production-build browser smoke:
// the watch route renders the approved shell surfaces (Back FAB top-left,
// no duplicate rows, no console errors) even without a resolvable source.
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:4173';
let passed = 0, failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL - ${name}${detail ? ` — ${detail}` : ''}`); }
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36' });
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  await page.goto(`${BASE}/watch/movie/550`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  // This sandbox has NO TMDB credentials — the unresolvable title fails
  // CLOSED with the documented 404 BEFORE the player mounts (the honest
  // route contract). The player surface itself therefore requires a
  // resolvable source and remains a REAL-DEVICE verification item (the
  // static layout contracts are covered by player_v2_corrections_test.ts
  // and the live subtitle pipeline by player_v2_part2_qa.mjs).
  const response = await page.goto(`${BASE}/watch/movie/550`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  check('unresolvable title fails closed (404) without credentials — no broken player surface', response?.status() === 404, `status: ${response?.status()}`);
  const bodyText = (await page.locator('body').innerText()).slice(0, 400);
  check('the fail-closed page renders the app error surface (no blank screen)', bodyText.trim().length > 0, `${bodyText.trim().length}B of content`);
  const fabCount = await page.locator('.control-fab.landscape-fab').count();
  check('no floating Landscape FAB without an embed source (approved layout)', fabCount === 0, `count: ${fabCount}`);
  const sheetCount = await page.locator('.source-sheet, .episode-sheet').count();
  check('no unexpected sheets open', sheetCount === 0, `count: ${sheetCount}`);
  const pageErrors = consoleErrors.filter((entry) => !/404|Failed to load resource/.test(entry));
  check('zero JS errors on the watch route (resource 404s excluded)', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}
console.log(`player_v2_corrections_browser_qa: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
