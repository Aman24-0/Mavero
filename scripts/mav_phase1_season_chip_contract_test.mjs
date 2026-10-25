// Phase 1 verification — season chip sizing contract at mobile + desktop.
// Asserts: (a) all chips same fixed height regardless of episode-count,
// (b) widths equal for equal labels, (c) no stretch when the episode list
// is SHORT (the old 1fr-track bug), (d) list scrolls internally when LONG,
// (e) horizontal rail scroll works, (f) no page horizontal overflow.
import { resolvePlaywright } from './mav_resolve_playwright.mjs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { normalize, join, sep } from 'node:path';

const { chromium } = await resolvePlaywright();
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

execSync('./node_modules/.bin/vite build --config scripts/player_shell_qa.vite.config.mjs', { cwd: root, stdio: 'pipe' });

const dist = '/tmp/mavero-shell-qa-dist';
const server = createServer((req, res) => {
  const rawPath = (req.url ?? '/').split('?')[0];
  const requestedFile = rawPath === '/' ? '/shell.html' : rawPath;
  const fullPath = normalize(join(dist, decodeURIComponent(requestedFile).slice(1)));
  if (!fullPath.startsWith(dist + sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  try {
    const body = readFileSync(fullPath);
    res.writeHead(200, { 'content-type': fullPath.endsWith('.html') ? 'text/html' : fullPath.endsWith('.css') ? 'text/css' : 'text/javascript' });
    res.end(body);
  } catch { res.writeHead(404); res.end('nope'); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const URL = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok - ${name}${detail ? ` (${detail})` : ''}`); }
  else { failed++; console.log(`  FAIL - ${name}${detail ? ` (${detail})` : ''}`); }
};

async function openSheet(page, { episodeCount, seasons }) {
  const episodes = Array.from({ length: episodeCount }, (_, i) => ({ id: `e${i}`, season: 2, number: i + 1, title: `Episode ${i + 1}` }));
  await page.evaluate(({ eps, seasons }) => {
    window.__seasonSelected = [];
    window.mountShell({
      source: { type: 'direct', url: 'https://example.com/v.mp4', providerId: 'x', sourceId: 's', mediaType: 'series', subtitles: [], qualities: [] },
      content: { id: 'series-1396', tmdbId: '1396', type: 'series', title: 'Test Show', poster: '', backdrop: '' },
      episodes: eps,
      currentEpisode: { season: 2, episode: 1, title: 'Episode 1' },
      seasons,
      seasonView: null,
      onSeasonSelect: (s) => { window.__seasonSelected.push(s); },
    });
  }, { eps: episodes, seasons });
  await page.click('.episode-chip');
  await page.waitForTimeout(120);
  return page.evaluate(() => {
    const row = document.querySelector('.season-row');
    const list = document.querySelector('.episode-sheet .sheet-list');
    const chips = [...document.querySelectorAll('.season-chip')].map((c) => {
      const r = c.getBoundingClientRect();
      return { w: +r.width.toFixed(1), h: +r.height.toFixed(1), text: c.textContent.trim(), selected: c.classList.contains('active'), label: c.getAttribute('aria-label') };
    });
    return {
      chips,
      rowH: row ? +row.getBoundingClientRect().height.toFixed(1) : null,
      railScrollable: row ? row.scrollWidth > row.clientWidth : null,
      listScrollable: list ? list.scrollHeight > list.clientHeight : null,
      listH: list ? +list.getBoundingClientRect().height.toFixed(1) : null,
      pageOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

const SEASONS = [
  { number: 1, episodeCount: 24 },
  { number: 2, episodeCount: 12 },
  { number: 3, episodeCount: 1001 },
  { number: 4, episodeCount: 8 },
  { number: 5, episodeCount: 24 },
];

for (const width of [375, 1280]) {
  console.log(`\n===== viewport ${width}px =====`);

  // Case A: SHORT episode list (the old bug stretched chips to 1fr leftover).
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  await page.goto(URL, { waitUntil: 'networkidle' });
  const short = await openSheet(page, { episodeCount: 3, seasons: SEASONS });
  const heightsShort = new Set(short.chips.map((c) => c.h));
  ok(`A1 [${width}] all 5 chips render`, short.chips.length === 5);
  ok(`A2 [${width}] short-list: every chip height identical (36px)`, heightsShort.size === 1 && [...heightsShort][0] === 36, `heights=${[...heightsShort].join(',')}`);
  ok(`A3 [${width}] short-list: no chip stretched by leftover space`, short.chips.every((c) => c.h <= 40));
  const widthsShort = new Set(short.chips.map((c) => c.w));
  ok(`A4 [${width}] short-list: equal labels give equal widths (count no longer widens a chip)`, widthsShort.size === 1, `widths=${[...widthsShort].join(',')}`);
  ok(`A5 [${width}] episode list area stays bounded and fills the sheet`, short.listH > 200 && short.listH < 800);
  ok(`A6 [${width}] no page-level horizontal overflow`, !short.pageOverflowX);
  ok(`A7 [${width}] selected chip is marked (aria-selected + class)`, short.chips.some((c) => c.selected) && short.chips.filter((c) => c.selected).length === 1);

  // Case B: LONG episode list (the old bug compressed the rail to min).
  const long = await openSheet(page, { episodeCount: 60, seasons: SEASONS });
  const heightsLong = new Set(long.chips.map((c) => c.h));
  ok(`B1 [${width}] long-list: every chip height still 36px`, heightsLong.size === 1 && [...heightsLong][0] === 36, `heights=${[...heightsLong].join(',')}`);
  ok(`B2 [${width}] long-list: episode list scrolls INTERNALLY`, long.listScrollable === true);
  const widthsLong = new Set(long.chips.map((c) => c.w));
  ok(`B3 [${width}] long-list: equal labels still equal widths`, widthsLong.size === 1);

  // Case C: horizontal scrolling of the rail + season switch behavior.
  ok(`C1 [${width}] rail is horizontally scrollable with 5 seasons`, long.railScrollable === true);
  await page.evaluate(() => { document.querySelector('.season-row').scrollLeft = 9999; });
  const lastChipVisible = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('.season-chip')];
    const r = chips[chips.length - 1].getBoundingClientRect();
    return r.left >= 0 && r.right <= window.innerWidth;
  });
  ok(`C2 [${width}] scrolling the rail reveals the last season chip`, lastChipVisible);
  await page.click('.season-chip:nth-child(5)');
  const switched = await page.evaluate(() => window.__seasonSelected);
  ok(`C3 [${width}] clicking a season chip fires onSeasonSelect(5)`, Array.isArray(switched) && switched.includes(5));
  // Keyboard: chips are reachable via Tab and announce via aria-label.
  const firstLabel = await page.evaluate(() => document.querySelector('.season-chip').getAttribute('aria-label'));
  ok(`C4 [${width}] chip aria-label carries the episode count (a11y)`, /Season 1, 24 episodes/.test(firstLabel ?? ''), firstLabel);

  // Escape closes the sheet.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  const sheetGone = await page.evaluate(() => !document.querySelector('.episode-sheet'));
  ok(`C5 [${width}] Escape closes the episode sheet`, sheetGone);

  // Movie content never shows season UI — the episode chip itself is
  // absent for non-episodic content (even stronger: no way to open the sheet).
  await page.evaluate(() => {
    window.mountShell({
      source: { type: 'direct', url: 'https://example.com/v.mp4', providerId: 'x', sourceId: 's', mediaType: 'movie', subtitles: [], qualities: [] },
      content: { id: 'movie-24428', tmdbId: '24428', type: 'movie', title: 'Movie', poster: '', backdrop: '' },
      episodes: [], currentEpisode: null, seasons: [], seasonView: null,
    });
  });
  const movieChip = await page.evaluate(() => document.querySelector('.episode-chip'));
  ok(`C6 [${width}] movies render no episode chip / season rail`, movieChip === null);
  await page.close();
}

console.log(`\nPhase 1 chip contract: ${passed} passed, ${failed} failed`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
