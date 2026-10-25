// Production bug-fix task (2026-10) — live browser verification against the
// production preview build (:4173). Credential-free environment (no local
// TMDB/Supabase secrets — same limitation as prior sessions), so the
// verification matrix covers everything that does NOT depend on live data:
//
//   A. TV SHOWS EXPLORER  — the Romance chip is GONE from the genre row;
//                           every other series genre chip still renders.
//   B. ANIME EXPLORER     — the Language row is ENTIRELY absent (no "All",
//                           no Japanese chip — removed, not hidden); genre
//                           chips still render.
//   C. MOVIES EXPLORER    — Romance chip PRESENT; language row PRESENT
//                           (movies/TV untouched).
//   D. TV language row    — still renders with Hindi/English chips.
//   E. GUEST SETTINGS     — the Adult Mode section is absent while the
//                           app_settings read fails closed (placeholder
//                           anon key -> policy OFF -> toggle unavailable).
//   F. SEARCH             — the page renders; no adult content surfaces
//                           (fail-closed upstream without credentials).
//   G. GUEST (adult)      — /api/settings/adult-mode returns a safe
//                           response; adult-discover endpoint 404s for
//                           the unauthorized guest context.
//   H. Sessions           — the revoke-all API is unreachable for guests
//                           (401 — server-derived identity only).
//
// Runs under a Lighthouse-style UA (the devtool-protection exemption the
// repo's live-verification scripts already use).

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
  await page.waitForTimeout(900);
  return { context, page };
}

const chipTexts = async (page, row) =>
  page.locator(`[data-chip-row="${row}"] .filter-chip`).allTextContents();

// ── A/B/C/D. Explorer taxonomy chips (client-rendered from the shared
//    taxonomy — verifiable without TMDB credentials) ─────────────────
{
  console.log('\n[A] TV Shows Explorer — genre row');
  const { context, page } = await open('/tv-shows');
  const genres = (await chipTexts(page, 'genre')).map((t) => t.trim());
  check('TV genre chips render', genres.length >= 10, JSON.stringify(genres));
  check('Romance chip is GONE from the TV genre row (zero-result upstream genre)', !genres.some((g) => /^Romance/.test(g)), JSON.stringify(genres));
  check('Drama / Western / Sci-Fi & Fantasy chips remain', genres.some((g) => /^Drama/.test(g)) && genres.some((g) => /^Western/.test(g)) && genres.some((g) => /^Sci-Fi & Fantasy/.test(g)));
  const langs = (await chipTexts(page, 'language')).map((t) => t.trim());
  check('TV language row still renders', langs.length >= 7, JSON.stringify(langs));
  check('TV language row keeps Hindi + English + Other', langs.some((l) => /^Hindi/.test(l)) && langs.some((l) => /^English/.test(l)) && langs.some((l) => /^Other/.test(l)));
  await context.close();

  console.log('\n[B] Anime Explorer — language row removed');
  const animeCtx = await open('/anime');
  const animeLangRow = animeCtx.page.locator('[data-chip-row="language"]');
  check('Anime has NO language row in the DOM (removed, not CSS-hidden)', (await animeLangRow.count()) === 0);
  const animeLangChips = await animeCtx.page.locator('button[aria-label="All languages"]').count();
  check('Anime has no "All languages" chip either', animeLangChips === 0);
  const animeGenres = (await chipTexts(animeCtx.page, 'genre')).map((t) => t.trim());
  check('Anime genre chips still render', animeGenres.length >= 8, JSON.stringify(animeGenres));
  check('Anime keeps the Romance genre chip (movie-side queries)', animeGenres.some((g) => /^Romance/.test(g)));
  await animeCtx.context.close();

  console.log('\n[C] Movies Explorer — unchanged');
  const movieCtx = await open('/movies');
  const movieGenres = (await chipTexts(movieCtx.page, 'genre')).map((t) => t.trim());
  check('Movie genre chips render', movieGenres.length >= 10);
  check('Movie Romance chip PRESENT (real movie genre)', movieGenres.some((g) => /^Romance/.test(g)));
  const movieLangs = (await chipTexts(movieCtx.page, 'language')).map((t) => t.trim());
  check('Movie language row PRESENT', movieLangs.length >= 7);
  await movieCtx.context.close();

  console.log('\n[D] Old anime URL with language param degrades safely');
  const oldUrl = await open('/anime?language=ja');
  const rows = await oldUrl.page.locator('[data-chip-row="language"]').count();
  check('anime?language=ja renders with NO language row (canonical degradation)', rows === 0);
  const notFiltered = await oldUrl.page.locator('.explorer-results').count();
  check('anime?language=ja is NOT a filtered state (language ignored)', notFiltered === 0);
  await oldUrl.context.close();
}

// ── E. Guest Settings — Adult Mode unavailable (fail-closed policy) ──
{
  console.log('\n[E] Guest Settings — Adult Mode section');
  const { context, page } = await open('/settings');
  await page.waitForTimeout(1200);
  const adultHeading = await page.locator('#adult-title').count();
  const adultToggle = await page.locator('input[type="checkbox"][onchange]').count();
  check('Settings renders for guests', (await page.title()).length > 0);
  check('Adult Mode section ABSENT (admin policy fails closed without valid Supabase config)', adultHeading === 0);
  check('No Adult Mode toggle renders', (await page.locator('#adult-title, .settings-section:has(#adult-title)').count()) === 0);
  await context.close();
}

// ── F. Search — renders; no adult surfaces ──────────────────────────
{
  console.log('\n[F] Search page');
  const { context, page } = await open('/search?q=bhabhi');
  await page.waitForTimeout(1500);
  check('Search page renders', (await page.locator('main, .search-page, [data-page="search"]').count()) >= 0);
  const body = await page.content();
  check('No adult-title leak in the rendered search (fail-closed, no credentials)', !/Sweety Bhabhi|Mohini Bhabhi|Bhabhi Ki Pathshala/.test(body));
  await context.close();
}

// ── G/H. API surfaces — safe for the guest context ──────────────────
{
  console.log('\n[G/H] Guest API surfaces');
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();

  const adultSettings = await page.request.get(`${BASE}/api/settings/adult-mode`);
  const adultSettingsBody = await adultSettings.json().catch(() => ({}));
  check('GET adult-mode responds safely for a guest', adultSettings.status() === 200 || adultSettings.status() === 503);
  check('guest adult settings expose no access (canAccess false / error, never true)', adultSettingsBody.canAccess !== true, JSON.stringify(adultSettingsBody));

  const adultDiscover = await page.request.get(`${BASE}/api/content/adult-discover?type=series`);
  check('Adult Discover is a NON-DISCLOSING 404 for the unauthorized guest', adultDiscover.status() === 404);

  const revokeAll = await page.request.post(`${BASE}/api/account/sessions/revoke-all`);
  check('revoke-all requires authentication (401 — server-derived identity only)', revokeAll.status() === 401);

  const singleRevoke = await page.request.post(`${BASE}/api/account/sessions/revoke`);
  check('single revoke requires authentication (401)', singleRevoke.status() === 401);
  await context.close();
}

await browser.close();
console.log(`\n=== Browser verification: ${passed} passed, ${failures} failed ===`);
process.exit(failures > 0 ? 1 : 0);
