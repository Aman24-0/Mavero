#!/usr/bin/env node
/**
 * MAVERO — wgt Stage-2 verify: REAL DATA over file:// (TV-engine simulation).
 *
 * Runs AFTER the boot smoke (wgt_file_smoke.mjs) against the SAME packed
 * artifact and verifies the Stage-2 data wiring end to end:
 *
 *   1. the wgt fetch bridge is installed (root-relative /api/... rewritten
 *      to the production API base);
 *   2. the widget issues REAL cross-origin requests to the production API
 *      and /api/tv/home (always CORS-open) succeeds;
 *   3. Home renders REAL data — TMDB posters/backdrops from the fetched
 *      payload (hero lineup), and the "The shelves are quiet." empty state
 *      is GONE;
 *   4. opening a card boots the DETAIL page with the real title;
 *   5. Search (/search + a live query) returns results;
 *   6. through ALL of it the boot overlay stays silent and no uncaught
 *      page error appears.
 *
 * DEPLOY-TIMING TOLERANCE: the CORS header change ships with the same push
 * that builds this .wgt, but the Netlify production deploy may still be in
 * flight when CI runs. The script therefore separates:
 *   - HARD requirements (always gate): the bridge installs, the shell boots,
 *     production is REACHED (a successful /api/tv/home response was
 *     observed), no overlay, no uncaught errors;
 *   - DATA requirements (gate in --strict mode): full rails/posters, detail
 *     and search results. Without --strict a data shortfall downgrades to a
 *     WARN (the deployed production does not carry the Stage-2 CORS headers
 *     yet) as long as production was reached and the honest empty state
 *     renders.
 * Run with --strict AFTER the deploy landed (locally or on TV) to gate on
 * the full Stage-2 contract.
 *
 * USAGE: node scripts/wgt_stage2_verify.mjs <MaveroTV.wgt | widget-dir> [--strict]
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { resolvePlaywright } from './mav_resolve_playwright.mjs';

const args = process.argv.slice(2).filter((a) => a !== '--strict');
const strict = process.argv.includes('--strict');
const arg = args[0];
if (!arg) {
  console.error('wgt_stage2_verify: ERROR — usage: node scripts/wgt_stage2_verify.mjs <MaveroTV.wgt | widget-dir> [--strict]');
  process.exit(1);
}

let widgetDir = path.resolve(arg);
let extractedDir = null;
if (arg.toLowerCase().endsWith('.wgt')) {
  if (!existsSync(arg)) {
    console.error(`wgt_stage2_verify: ERROR — ${arg} does not exist`);
    process.exit(1);
  }
  extractedDir = mkdtempSync(path.join(tmpdir(), 'mavero-wgt-stage2-'));
  const { execFileSync } = await import('node:child_process');
  execFileSync('unzip', ['-q', path.resolve(arg), '-d', extractedDir], { stdio: 'pipe' });
  widgetDir = extractedDir;
  console.log(`wgt_stage2_verify: extracted the .wgt to ${extractedDir}`);
}

const entry = path.join(widgetDir, 'index.html');
if (!existsSync(entry)) {
  console.error(`wgt_stage2_verify: ERROR — no index.html in ${widgetDir}`);
  if (extractedDir) rmSync(extractedDir, { recursive: true, force: true });
  process.exit(1);
}

const fatal = [];
const warnings = [];

const fail = async (page, diagnostics, message) => {
  console.error(`wgt_stage2_verify: FAIL — ${message}`);
  try {
    const overlay = await page.evaluate(() => {
      const el = document.getElementById('mavero-wgt-boot-overlay');
      return el ? el.innerText : null;
    });
    if (overlay) console.error('--- on-screen boot overlay text ---\n' + overlay);
    const status = await page.evaluate(() => {
      const el = document.getElementById('mavero-tv-status');
      return el ? el.innerText : null;
    });
    if (status) console.error('--- TV status strip text ---\n' + status);
  } catch (e) {}
  if (diagnostics.console.length) {
    console.error('--- console messages (last 12) ---');
    for (const line of diagnostics.console.slice(-12)) console.error('  ' + line);
  }
  if (diagnostics.pageErrors.length) {
    console.error('--- page errors ---');
    for (const line of diagnostics.pageErrors) console.error('  ' + line);
  }
  await browser.close().catch(() => {});
  if (extractedDir) rmSync(extractedDir, { recursive: true, force: true });
  process.exit(1);
};

const { chromium } = await resolvePlaywright();
const browser = await chromium.launch({
  headless: true,
  args: ['--allow-file-access-from-files']
});
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  locale: 'en-US'
});

// The TV-engine simulation (identical to the boot smoke).
await context.addInitScript(() => {
  try { delete Object.hasOwn; } catch (e) {}
  try { delete Object.fromEntries; } catch (e) {}
  try { delete String.prototype.replaceAll; } catch (e) {}
  try { delete window.WeakRef; } catch (e) {}
  try { delete window.FinalizationRegistry; } catch (e) {}
  try { delete Array.prototype.at; } catch (e) {}
  try { delete String.prototype.at; } catch (e) {}
  try { delete Array.prototype.findLast; } catch (e) {}
  try { delete Array.prototype.findLastIndex; } catch (e) {}
  try { delete Promise.allSettled; } catch (e) {}
  try { delete Promise.any; } catch (e) {}
  try { delete window.AggregateError; } catch (e) {}
  try { delete window.queueMicrotask; } catch (e) {}
  try { delete Array.prototype.flat; } catch (e) {}
  try { delete Array.prototype.flatMap; } catch (e) {}
  try { delete window.structuredClone; } catch (e) {}
});

const page = await context.newPage();
const diagnostics = { console: [], pageErrors: [] };
page.on('console', (msg) => {
  if (diagnostics.console.length < 200) {
    diagnostics.console.push(`[${msg.type()}] ${msg.text()}`.slice(0, 240));
  }
});
page.on('pageerror', (err) => {
  diagnostics.pageErrors.push(String(err && err.stack ? err.stack : err).slice(0, 600));
});

// Observe REAL cross-origin API traffic + its outcomes.
const apiResponses = [];
page.on('response', (response) => {
  try {
    const url = response.url();
    if (url.includes('maveroweb.space/api/')) {
      apiResponses.push({ path: url.replace(/^https:\/\/maveroweb\.space/, ''), status: response.status() });
    }
  } catch (e) {}
});

const fileUrl = 'file://' + entry.split(path.sep).join('/');
console.log(`wgt_stage2_verify: booting ${fileUrl}${strict ? ' (--strict)' : ''}`);
await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

// ---- 1. HARD: bridge installed, shell booted, no overlay -------------------
try {
  await page.waitForFunction(() => window.__maveroTvFetchBridge === true, null, { timeout: 30000 });
} catch (e) {
  await fail(page, diagnostics, 'the wgt fetch bridge never installed (window.__maveroTvFetchBridge !== true)');
}
console.log('wgt_stage2_verify: fetch bridge installed');

try {
  await page.waitForSelector('aside.app-sidebar', { state: 'visible', timeout: 45000 });
} catch (e) {
  await fail(page, diagnostics, 'aside.app-sidebar never rendered');
}

const overlayState = await page.evaluate(() => {
  const el = document.getElementById('mavero-wgt-boot-overlay');
  if (!el) return { present: false, visible: false };
  return { present: true, visible: el.style.display !== 'none' && el.offsetWidth > 0 };
});
if (overlayState.present && overlayState.visible) {
  await fail(page, diagnostics, 'the boot-error overlay is visible during the Stage-2 run');
}

// ---- 2. HARD: production was REACHED (a real API response landed) ----------
try {
  await page.waitForFunction(
    () => window.__maveroTvFetchBridge === true && Boolean(document.querySelector('aside.app-sidebar')),
    null,
    { timeout: 10000 }
  );
  // Give the payload fetch a moment to complete, then inspect traffic.
  await page.waitForTimeout(8000);
} catch (e) {}
const tvHomeHit = apiResponses.find((r) => r.path.startsWith('/api/tv/home') && r.status === 200);
const anyApiHit = apiResponses.some((r) => r.status === 200);
if (!tvHomeHit && !anyApiHit) {
  await fail(page, diagnostics, `no successful production API response observed (got ${apiResponses.length} requests) — is the network available?`);
}
console.log(`wgt_stage2_verify: production API reached — ${apiResponses.filter((r) => r.status === 200).length}/${apiResponses.length} responses OK, /api/tv/home: ${tvHomeHit ? '200' : 'no 200 yet'}`);

// ---- 3. DATA: real rails/posters; empty state gone -------------------------
await page.waitForTimeout(4000); // let the payload settle
const homeState = await page.evaluate(() => ({
  tmdbImgs: document.querySelectorAll('img[src*="image.tmdb.org"], img[srcset*="image.tmdb.org"]').length,
  cards: document.querySelectorAll('.mc-card-link, .mc-card').length,
  emptyState: Boolean(document.querySelector('.empty-state')),
  heroFallback: Boolean(document.querySelector('.hero-fallback')),
  tvStatus: document.getElementById('mavero-tv-status') ? document.getElementById('mavero-tv-status').innerText.slice(0, 200) : null
}));

if (homeState.emptyState && homeState.tmdbImgs === 0) {
  const message = 'Home still renders the empty state with zero TMDB images — the payload fetch failed';
  if (strict) await fail(page, diagnostics, message);
  fatal.push(`${message} (strict)`);
  warnings.push(message);
} else if (homeState.cards < 6) {
  const message = `only ${homeState.cards} media cards rendered (${homeState.tmdbImgs} TMDB images) — the section rails need the Stage-2 CORS headers on the DEPLOYED production (deploy may still be in flight)`;
  if (strict) await fail(page, diagnostics, message);
  warnings.push(message);
} else {
  console.log(`wgt_stage2_verify: Home shows REAL data — ${homeState.cards} media cards, ${homeState.tmdbImgs} TMDB images`);
}
if (homeState.tmdbImgs > 0 && !homeState.emptyState) {
  console.log(`wgt_stage2_verify: hero renders real content (${homeState.tmdbImgs} TMDB images, empty state gone)`);
}
const oversized = await page.evaluate(() =>
  [...document.querySelectorAll('img')]
    .map((img) => `${img.getAttribute('src') || ''} ${img.getAttribute('srcset') || ''}`)
    .join(' ')
    .includes('image.tmdb.org/t/p/original')
);
if (oversized) {
  await fail(page, diagnostics, 'an original-size TMDB image URL leaked into the TV payload (must be w342/w500/w780/w1280)');
}

// ---- 4. DATA: detail opens with the real title ------------------------------
const firstCardHref = await page.evaluate(() => {
  const card = document.querySelector('a.mc-card-link[href*="/movie/"], a.mc-card-link[href*="/tv-show/"], a.mc-card-link[href*="/anime-movie/"], a.mc-card-link[href*="/anime-series/"]');
  return card ? card.getAttribute('href') : null;
});
if (firstCardHref) {
  await page.evaluate((href) => {
    const card = document.querySelector(`a.mc-card-link[href="${href}"]`);
    if (card) card.click();
  }, firstCardHref);
  try {
    await page.waitForFunction(
      () => location.hash.includes('/movie/') || location.hash.includes('/tv-show/') || location.hash.includes('/anime-movie/') || location.hash.includes('/anime-series/'),
      null,
      { timeout: 20000 }
    );
    // The detail hero first renders the static local stub ("Afterlight") and
    // swaps in the REAL fetched item when /api/tv/content answers — wait for
    // the title to leave the stub so this gates the DATA wiring, not the
    // fallback.
    await page.waitForFunction(
      () => {
        const hero = document.querySelector('.detail-hero h1, .detail-title, h1');
        const title = hero ? hero.textContent.trim() : '';
        return title.length > 1 && title !== 'Afterlight';
      },
      null,
      { timeout: 30000 }
    );
    const detailTitle = await page.evaluate(() => {
      const hero = document.querySelector('.detail-hero h1, .detail-title, h1');
      return hero ? hero.textContent.trim() : '';
    });
    console.log(`wgt_stage2_verify: Detail opened with the REAL title "${detailTitle}"`);
  } catch (e) {
    const message = `detail page did not boot with real data for ${firstCardHref} (needs the deployed /api/tv/content endpoint)`;
    if (strict) await fail(page, diagnostics, message);
    warnings.push(message);
  }
} else {
  const message = 'no detail-capable card link on Home to click (rails not rendered — see the data note above)';
  if (strict) await fail(page, diagnostics, message);
  warnings.push(message);
}

// ---- 5. DATA: search returns results ----------------------------------------
await page.goto(`${fileUrl}#/search`, { waitUntil: 'domcontentloaded', timeout: 60000 });
let resultCount = 0;
try {
  await page.waitForSelector('input[type="search"], input[type="text"], input', { state: 'visible', timeout: 30000 });
  await page.fill('input[type="search"], input[type="text"], input', 'spider');
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('.mc-card-link, .mc-card').length > 0,
      null,
      { timeout: 30000 }
    );
    resultCount = await page.evaluate(() => document.querySelectorAll('.mc-card-link, .mc-card').length);
    console.log(`wgt_stage2_verify: Search returned ${resultCount} result cards for "spider"`);
  } catch (e) {
    const message = 'Search returned no results for a live query (needs the deployed CORS headers on /api/content/search)';
    if (strict) await fail(page, diagnostics, message);
    warnings.push(message);
  }
} catch (e) {
  const message = 'the search input never rendered';
  if (strict) await fail(page, diagnostics, message);
  warnings.push(message);
}

// ---- 6. HARD: no uncaught page errors ---------------------------------------
if (diagnostics.pageErrors.length > 0) {
  await fail(page, diagnostics, `${diagnostics.pageErrors.length} uncaught page error(s) during the Stage-2 run`);
}

if (fatal.length > 0 && strict) {
  await fail(page, diagnostics, fatal.join('; '));
}

console.log('wgt_stage2_verify: RESULT — HARD requirements passed (bridge, boot, production reached, no overlay, no page errors)');
for (const w of warnings) console.log(`wgt_stage2_verify: WARN — ${w}`);
if (warnings.length > 0 && !strict) {
  console.log('wgt_stage2_verify: data-tier shortfalls tolerated OUTSIDE --strict (the Netlify deploy of the Stage-2 CORS headers may still be in flight). Re-run with --strict after the deploy, or verify on the TV.');
}
console.log(`wgt_stage2_verify: PASS${warnings.length && !strict ? ' (with warnings)' : ''}`);

await browser.close();
if (extractedDir) rmSync(extractedDir, { recursive: true, force: true });
process.exit(0);
