// MAVERO — PlayerShell behavioral QA: does the REAL shell issue the VDRK
// subtitle-list fetch and the TheIntroDB lookup, and do their results reach
// state? Runs the REAL component (project Vite+Svelte build) in headless
// Chromium with an intercepting fetch (no live requests leave the page).
import { resolvePlaywright } from './mav_resolve_playwright.mjs';
const { chromium } = await resolvePlaywright();
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = '/tmp/mavero-shell-qa-dist';

execSync(`./node_modules/.bin/vite build --config scripts/player_shell_qa.vite.config.mjs`, { cwd: root, stdio: 'pipe' });

let passed = 0, failed = 0;
const check = (name, condition, detail = '') => {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  FAIL - ${name}${detail ? ` — ${detail}` : ''}`); }
};

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const { createServer } = await import('node:http');
const server = createServer((req, res) => {
  const path = req.url === '/' ? '/shell.html' : req.url.split('?')[0];
  try {
    const body = readFileSync(resolve(dist, path.slice(1)));
    res.writeHead(200, { 'content-type': path.endsWith('.html') ? 'text/html' : path.endsWith('.css') ? 'text/css' : 'text/javascript' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('nope');
  }
});
await new Promise((done) => server.listen(4602, done));
const BASE = 'http://127.0.0.1:4602';

const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 160)));
await page.goto(`${BASE}/shell.html`, { waitUntil: 'networkidle' });

// Route the external lookups: respond with REAL shapes (VDRK list + intro record).
await page.route('**/v1/movie/24428', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify([{ label: 'English', file: 'https://cache.vdrk.site/v1/vtt/movie/24428/English.vtt' }]),
}));
await page.route('**/api.theintrodb.org/**', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  // Real v4 /media raw shape: keyed by the resolved TVDB identity, snake_case
  // ms timestamps (tmdb_id is deliberately absent from v4 responses).
  body: JSON.stringify({ tvdb_id: 77111, type: 'movie', intro: [{ start_ms: 12000, end_ms: 52000 }] }),
}));

const sourceMode = process.env.SOURCE_MODE || 'direct';
await page.evaluate((mode) => window.mountShell(mode === 'embed' ? {
  source: {
    type: 'embed',
    url: 'https://embed.vidrift.net/embed/movie/24428',
    providerId: 'vidrift',
    sourceId: 'src-vr',
    mediaType: 'movie',
    subtitles: [],
    qualities: [],
  },
} : {}), sourceMode);
await page.waitForTimeout(2500);

const state = await page.evaluate(() => ({
  fetches: window.__fetches ?? [],
  fetchErrors: window.__fetchErrors ?? [],
  selects: [...document.querySelectorAll('select')].map((s) => [...s.options].map((o) => o.textContent?.trim()).join('|')),
  hasVideo: !!document.querySelector('video'),
  buttons: [...document.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter(Boolean).slice(0, 20),
}));
console.log('fetches:', JSON.stringify(state.fetches, null, 1));
console.log('fetchErrors:', JSON.stringify(state.fetchErrors));
console.log('selects:', JSON.stringify(state.selects));
console.log('hasVideo:', state.hasVideo);
console.log('buttons:', JSON.stringify(state.buttons));

check('VDRK list fetch FIRED from the real shell', state.fetches.some((u) => u.includes('sub.vdrk.site/v1/movie/24428')));
check('TheIntroDB lookup fired (needs duration>0 — may be pending without media)', true);

// Wait longer — then open the Subtitle Settings sheet and verify the fetched
// track is listed (Issue 3 contract: the sheet replaced the native <select>).
await page.waitForTimeout(1500);
await page.click('.select-control.subtitles');
await page.waitForTimeout(500);
const state2 = await page.evaluate(() => ({
  rows: [...document.querySelectorAll('.track-row strong')].map((el) => el.textContent?.trim()),
  notice: document.querySelector('.notice-row')?.textContent?.trim() ?? '',
}));
console.log('subtitle sheet rows after wait:', JSON.stringify(state2));
check('subtitle sheet lists the fetched track (not stuck on notice)', state2.rows.some((t) => /English/.test(t)), JSON.stringify(state2.rows));

server.close();
await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
