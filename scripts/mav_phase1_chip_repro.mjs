// Phase 1 reproduction — episode-sheet season chip sizing at mobile width.
// Mounts the REAL PlayerShell via the existing shell harness, opens the
// episode sheet with 6 seasons, and measures every chip's box.
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

async function measure(width) {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  await page.goto(URL, { waitUntil: 'networkidle' });
  const episodes = Array.from({ length: 12 }, (_, i) => ({ id: `e${i}`, season: 2, number: i + 1, title: `Episode ${i + 1}` }));
  await page.evaluate((eps) => {
    window.__epChange = [];
    window.mountShell({
      source: { type: 'direct', url: 'https://example.com/v.mp4', providerId: 'x', sourceId: 's', mediaType: 'series', subtitles: [], qualities: [] },
      content: { id: 'series-1396', tmdbId: '1396', type: 'series', title: 'Test Show', poster: '', backdrop: '' },
      episodes: eps,
      currentEpisode: { season: 2, episode: 4, title: 'Episode 4' },
      seasons: [
        { number: 1, episodeCount: 24 },
        { number: 2, episodeCount: 12 },
        { number: 3, episodeCount: 1001 },
        { number: 4, episodeCount: 8 },
        { number: 5, episodeCount: 24 },
        { number: 6, episodeCount: 24 },
      ],
      seasonView: null,
      onSeasonSelect: (s) => { window.__epChange.push(s); },
    });
  }, episodes);
  // Open the episode sheet via the left-edge episode chip.
  await page.click('.episode-chip');
  await page.waitForTimeout(150);
  const data = await page.evaluate(() => {
    const sheet = document.querySelector('.episode-sheet');
    const row = document.querySelector('.season-row');
    const chips = [...document.querySelectorAll('.season-chip')];
    const list = document.querySelector('.episode-sheet .sheet-list');
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { w: +r.width.toFixed(1), h: +r.height.toFixed(1), top: +r.top.toFixed(1), left: +r.left.toFixed(1) };
    };
    return {
      sheetRect: sheet ? rect(sheet) : null,
      rowRect: row ? rect(row) : null,
      rowScroll: row ? { scrollW: row.scrollWidth, clientW: row.clientWidth, scrollable: row.scrollWidth > row.clientWidth } : null,
      listRect: list ? rect(list) : null,
      listScroll: list ? { scrollH: list.scrollHeight, clientH: list.clientHeight, scrollable: list.scrollHeight > list.clientHeight } : null,
      chips: chips.map((c) => ({ ...rect(c), text: c.textContent.trim(), selected: c.classList.contains('active'), ariaSelected: c.getAttribute('aria-selected') })),
      docOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  await page.close();
  return data;
}

for (const width of [375, 1280]) {
  const d = await measure(width);
  console.log(`\n===== viewport ${width}px =====`);
  console.log('sheet:', JSON.stringify(d.sheetRect));
  console.log('season-row:', JSON.stringify(d.rowRect), 'scroll:', JSON.stringify(d.rowScroll));
  console.log('sheet-list:', JSON.stringify(d.listRect), 'scroll:', JSON.stringify(d.listScroll));
  for (const c of d.chips) {
    console.log(`  chip "${c.text}" sel=${c.selected} ${c.w}x${c.h} top=${c.top}`);
  }
  console.log('page horizontal overflow:', d.docOverflowX);
}

await browser.close();
server.close();
