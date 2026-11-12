// 2026-10-07 second-round adult leak hardening — live browser verification
// against the production preview build (:4173).
//
// Credential-free environment (no local TMDB secrets — same limitation as
// prior sessions; live TMDB data facts were verified against the public
// TMDB website during the audit and are locked by
// scripts/adult_orphan_leak_regression_test.ts). This script verifies
// everything observable in the browser without upstream credentials:
//
//   A. DISCOVER — the "Indian Adult Shows" section either (a) stays hidden
//      while the authorization context is OFF (the section must never
//      surface without authorization), or (b) when the Supabase-configured
//      policy allows the guest context, renders WITHOUT any Movies/TV
//      media-type selector (the removed dead selector) and WITH the
//      provider dropdown (closed union).
//   B. SEARCH — "Charmsukh" / "Bhabhi Ji Suniya Na" / "Sweety Bhabhi"
//      return NO adult items (fail-closed upstream without credentials;
//      fixture fallback contains zero adult titles — locked by tests).
//   C. LEGITIMATE CONTROL — the search page still renders results/empty
//      states normally (no crash, no error banner).
//   D. DIRECT API — /api/content/adult-discover answers the unauthorized
//      context with the non-disclosing 404 (no adult data, no hint), and
//      /api/discover/adult-providers answers ok:[] (no provider leak).
//   E. UI STRUCTURE — the compiled AdultDiscoverSection bundle contains no
//      TYPE_OPTIONS/media-type dropdown code path (selector fully removed
//      from the shipped client bundle, not just hidden).

import { chromium } from 'playwright';

const BASE = 'http://localhost:4173';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Chrome-Lighthouse';

let failures = 0;
let passed = 0;
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (ok) passed++; else failures++;
  console.log(`${ok ? '  ok' : '  FAIL'} — ${label}${detail && !ok ? ` (${detail})` : ''}`);
}

const browser = await chromium.launch();

async function open(path) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: UA });
  const page = await context.newPage();
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  return { context, page };
}

const ADULT_TITLE_MARKERS = /indian adult shows/i;

// ── A. Discover: adult section visibility + selector removal ────────────
{
  console.log('\n[A] Discover — Indian Adult Shows section');
  const { context, page } = await open('/discover');
  // Scroll down so lazy sections render.
  await page.mouse.wheel(0, 3200);
  await page.waitForTimeout(1200);
  const section = page.locator('[data-adult-surface]');
  const sectionCount = await section.count();
  if (sectionCount === 0) {
    check('adult section hidden while the authorization context is OFF (fail-closed)', true);
  } else {
    const head = section.first().locator('.section-head');
    // The removed Movies/TV selector: there must be EXACTLY ONE dropdown in
    // the section header (the provider filter) — no media-type dropdown.
    const dropdowns = await head.locator('.discover-dropdown').count();
    check('exactly ONE filter dropdown in the section header (provider only — Movies/TV selector removed)', dropdowns === 1, `dropdowns=${dropdowns}`);
    const triggerLabels = await head.locator('.dd-trigger .dd-label').allTextContents();
    check('no "TV Shows"/"Movies" media-type label in the header', !triggerLabels.some((t) => /^tv shows$|^movies$/i.test(t.trim())), JSON.stringify(triggerLabels));
    const providerTrigger = head.locator('.discover-dropdown .dd-trigger').first();
    await providerTrigger.click();
    await page.waitForTimeout(500);
    const options = await head.locator('[role="option"]').allTextContents();
    check('provider dropdown opens with a closed-union option list', options.length >= 2, JSON.stringify(options.slice(0, 6)));
    check('"All" option present', options.some((t) => /^all$/i.test(t.trim())));
    // 12 verified networks when the list endpoint is reachable and authorized.
    if (options.length > 2) {
      console.log(`       provider options served: ${options.map((t) => t.trim()).join(', ')}`);
    }
  }
  await context.close();
}

// ── B. Search: no adult leak under the fail-closed context ─────────────
{
  console.log('\n[B] Search — adult leak matrix (fail-closed upstream)');
  for (const query of ['Charmsukh', 'Bhabhi Ji Suniya Na', 'Sweety Bhabhi']) {
    const { context, page } = await open(`/search?q=${encodeURIComponent(query)}`);
    const bodyText = await page.locator('body').innerText();
    const adultMarkers = [
      /charmsukh/i, /bhabhi ji suniya/i, /sweety bhabhi/i, /mohini bhabhi/i,
      /bhabhi ki pathshala/i, /palang tod/i, /kavita bhabhi/i, /gharwali baharwali/i
    ];
    // Under fail-closed upstream the page may legitimately show the empty or
    // error state; it must never list the adult ecosystem titles.
    const leaked = adultMarkers.filter((marker) => marker.test(bodyText));
    check(`search "${query}" surfaces no adult ecosystem title`, leaked.length === 0, leaked.map((m) => String(m)).join(','));
    check(`search "${query}" page renders (no crash)`, !/internal server error/i.test(bodyText));
    await context.close();
  }
}

// ── C. Legitimate control: search still works ───────────────────────────
{
  console.log('\n[C] Search — legitimate control');
  const { context, page } = await open('/search?q=Bhabiji');
  const bodyText = await page.locator('body').innerText();
  check('control search "Bhabiji" renders without crash', !/internal server error/i.test(bodyText));
  check('control search never over-blocks the page itself (empty or results state renders)', /search/i.test(bodyText));
  await context.close();
}

// ── D. Direct API: non-disclosing 404 + empty provider list ─────────────
{
  console.log('\n[D] Direct API — unauthorized context');
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();
  const adultDiscover = await page.request.get(`${BASE}/api/content/adult-discover`);
  check('GET /api/content/adult-discover (unauthorized) -> 404 non-disclosing', adultDiscover.status() === 404, `status=${adultDiscover.status()}`);
  const adultDiscoverMovie = await page.request.get(`${BASE}/api/content/adult-discover?type=movie`);
  // Stale movie parameter: 404 (authorization first) — never a movie catalog.
  check('GET /api/content/adult-discover?type=movie (unauthorized) -> 404, never a movie catalog', adultDiscoverMovie.status() === 404, `status=${adultDiscoverMovie.status()}`);
  const providers = await page.request.get(`${BASE}/api/discover/adult-providers`);
  let providerPayload = null;
  try { providerPayload = await providers.json(); } catch { /* non-json */ }
  check('GET /api/discover/adult-providers (unauthorized) -> ok with EMPTY list (non-disclosing)', providers.status() === 200 && Array.isArray(providerPayload?.providers) && providerPayload.providers.length === 0, `status=${providers.status()}`);
  await context.close();
}

// ── E. Shipped client bundle: media-type selector code path removed ─────
{
  console.log('\n[E] Client bundle — selector removal (minification-robust)');
  // Scan the BUILT chunks on disk (runtime scanning misses lazy chunks when
  // the section is hidden). The AdultDiscoverSection chunk is identified by
  // its '/api/content/adult-discover' fetch URL.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const chunksDir = path.resolve(process.cwd(), 'build/_app/immutable');
  let adultChunk = '';
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (text.includes('/api/content/adult-discover')) adultChunk += text;
    }
  };
  walk(chunksDir);
  check('the AdultDiscoverSection chunk exists in the shipped bundle', adultChunk.length > 0);
  // The request builder carries provider + page ONLY (no type parameter —
  // the minified shape is new URLSearchParams({provider:...,page:...})).
  check('adult-discover query builder sends provider + page ONLY (no type)', /new URLSearchParams\(\{provider:[\s\S]{0,40}page:/.test(adultChunk));
  check('no media-type label strings in the Adult section chunk', !/"TV Shows"/.test(adultChunk) && !/label:"Movies"/.test(adultChunk));
  check('the provider filter remains (policy-gated provider options fetch)', adultChunk.includes('/api/discover/adult-providers'));
  check('the non-disclosing 404 handling remains', adultChunk.includes('status===404') || adultChunk.includes('status === 404'));
}

console.log(`\nRESULT: ${passed} passed, ${failures} failed — ${failures === 0 ? 'BROWSER QA PASS' : 'BROWSER QA FAIL'}`);
process.exitCode = failures === 0 ? 0 : 1;
await browser.close();
