import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ============================================================================
// MAV-22 — Production-Grade Cinematic Detail Page 3.0 regression suite.
//
// The Detail Page (movie / TV series / anime movie / anime series) was
// rebuilt around the APPROVED cinematic-overlap layout:
//
//   • POSTER-OVERLAP HERO: the poster card overlaps the cinematic
//     backdrop area on EVERY surface, with the title + compact metadata
//     BESIDE it (mobile included), genre chips, a 2-line synopsis
//     preview, the dominant Play/Resume/Continue Watching action, the
//     approved secondary row (Watching · Share · Trailer), and a
//     COMPACT provider-availability strip near the actions.
//   • DYNAMIC ARTWORK PALETTE: the page background is derived from the
//     CURRENT title's artwork (backdrop → poster → neutral cinematic
//     fallback). Restrained dark variants only — never raw poster
//     colors, never the fixed global background, never the global green
//     accent. CORS-safe (direct CORS attempt → same-origin artwork
//     proxy), bounded LRU cache keyed by the artwork URL, race-guarded
//     (stale extractions discarded), scoped to the detail page only.
//   • METADATA DEDUP: the hero shows rating/year/runtime-or-counts/
//     certification; More Details shows ONLY facts the hero does not
//     (full release date, director/creators, language, episode count).
//   • RECTANGULAR CAST CARDS (2:3 portraits) replace the circular
//     avatars; the two-column More Details grid replaces the vertical
//     fact list; You May Also Like uses portrait recommendation cards.
//   • EVERY existing behavior is preserved: playback/resume/download,
//     Watching/watchlist, Share, Trailer, seasons/episodes + progress,
//     recommendations, back policy, SEO head, trailer focus trap.
//
// This suite locks the contract at the source level AND executes the
// pure derivation logic (palette math, cache, race guard, label policy,
// dedup policy) against synthetic data — the repository's established
// regression convention.
// ============================================================================

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const detailPage = read('../src/lib/components/DetailPage.svelte');
const paletteSrc = read('../src/lib/client/detail/palette.ts');
const proxySrc = read('../src/routes/api/content/artwork-proxy/+server.ts');
const appCss = read('../src/app.css');

import {
  rgbToHsl,
  hslToRgb,
  mixTowardBase,
  derivePaletteFromPixels,
  buildPaletteStyle,
  NEUTRAL_FALLBACK,
  getCachedPalette,
  setCachedPalette,
  clearPaletteCache,
  DetailPaletteController,
  extractArtworkPalette,
  type DetailPalette
} from '../src/lib/client/detail/palette';

// ============================================================
// 1. Palette math — pure, correct, Node-runnable
// ============================================================
console.log('\n1. Palette color math');

// rgbToHsl round-trips.
const greenHsl = rgbToHsl(0, 255, 156);
assert.ok(Math.abs(greenHsl.h - 156.6) < 1, `rgbToHsl: Mavero green hue ≈ 156.6° (got ${greenHsl.h.toFixed(1)}°)`);
assert.ok(greenHsl.s > 0.95 && greenHsl.l > 0.4, 'rgbToHsl: vivid green saturation/lightness');
const roundTrip = hslToRgb(greenHsl.h, greenHsl.s, greenHsl.l);
assert.deepEqual(roundTrip, { r: 0, g: 255, b: 156 }, 'hslToRgb inverts rgbToHsl exactly');
assert.deepEqual(hslToRgb(210, 0, 0.1), { r: 26, g: 26, b: 26 }, 'hslToRgb: s=0 → neutral gray');

// mixTowardBase blends the deep tone toward the global base.
const mixed = mixTowardBase(150, 0.5, 0.07, 1);
assert.equal(mixed, 'rgb(5, 7, 8)', 'mixTowardBase t=1 lands exactly on the global base #050708');
const unmixed = mixTowardBase(150, 0.5, 0.07, 0);
assert.ok(unmixed !== mixed, 'mixTowardBase t=0 keeps the source color');

// Server-safety: the module imports and runs in Node (no window).
assert.equal(typeof derivePaletteFromPixels, 'function', 'palette module imports on the server');
ok('1. color math pure + exact round-trips + base blending');

// ============================================================
// 2. Palette derivation — DIFFERENT artwork → DIFFERENT palettes
// ============================================================
console.log('\n2. Palette derivation (objective multi-artwork evidence)');

// Synthetic pixel-set builders (RGBA, 4 bytes per pixel).
function solidPixels(r: number, g: number, b: number, count = 512): number[] {
  const px: number[] = [];
  for (let i = 0; i < count; i += 1) px.push(r, g, b, 255);
  return px;
}
function stripedPixels(stops: Array<[number, number, number]>, count = 512): number[] {
  const px: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const [r, g, b] = stops[i % stops.length];
    px.push(r, g, b, 255);
  }
  return px;
}

// Green-dominant artwork (foliage) → deep forest palette.
const greenPalette = derivePaletteFromPixels(stripedPixels([[24, 160, 72], [16, 128, 56], [40, 180, 90]]), 'green-art');
assert.equal(greenPalette.neutral, false, 'green artwork is chromatic');
assert.ok(greenPalette.hue > 100 && greenPalette.hue < 170, `green artwork → green hue (got ${Math.round(greenPalette.hue)}°)`);
assert.ok(/hsl\(\s*1\d\d/.test(greenPalette.deep) || /hsl\(1[0-7]\d/.test(greenPalette.deep), 'green deep tone preserves the green hue family');

// Blue-dominant artwork (ocean) → deep navy palette.
const bluePalette = derivePaletteFromPixels(stripedPixels([[20, 80, 200], [16, 64, 170], [40, 100, 220]]), 'blue-art');
assert.ok(bluePalette.hue > 200 && bluePalette.hue < 250, `blue artwork → blue hue (got ${Math.round(bluePalette.hue)}°)`);

// Warm orange/brown artwork (desert) → dark bronze palette.
const orangePalette = derivePaletteFromPixels(stripedPixels([[220, 120, 30], [190, 100, 24], [240, 140, 40]]), 'orange-art');
assert.ok(orangePalette.hue < 60 || orangePalette.hue > 320, `orange artwork → warm hue (got ${Math.round(orangePalette.hue)}°)`);

// OBJECTIVE: the three artworks produce three DIFFERENT deep tones.
assert.notEqual(greenPalette.deep, bluePalette.deep, 'green vs blue artwork → different deep tones');
assert.notEqual(bluePalette.deep, orangePalette.deep, 'blue vs orange artwork → different deep tones');
assert.notEqual(greenPalette.deep, orangePalette.deep, 'green vs orange artwork → different deep tones');
assert.notEqual(greenPalette.accent, bluePalette.accent, 'different artwork → different accents');

// Restrained dark variants: deep tones stay in the deep cinematic band.
for (const palette of [greenPalette, bluePalette, orangePalette]) {
  const m = palette.deep.match(/hsl\((\d+), (\d+)%, (\d+)%\)/);
  assert.ok(m, `deep tone is an hsl() string: ${palette.deep}`);
  const l = Number(m![3]) / 100;
  const s = Number(m![2]) / 100;
  assert.ok(l <= 0.1, `deep tone is DARK (L=${(l * 100).toFixed(0)}% ≤ 10%) — never a raw bright poster color`);
  assert.ok(s >= 0.18 && s <= 0.55, `deep saturation is restrained (S=${(s * 100).toFixed(0)}%)`);
}

// Achromatic artwork → the neutral cinematic family (never the accent).
const grayPalette = derivePaletteFromPixels(solidPixels(128, 128, 128), 'gray-art');
assert.equal(grayPalette.neutral, true, 'achromatic artwork → neutral palette');
assert.equal(grayPalette.hue, 210, 'neutral palette uses the cool slate hue family');

// Transparent pixels are skipped (alpha < 200).
const transparentPalette = derivePaletteFromPixels(solidPixels(20, 80, 200, 64).map((v, i) => (i % 4 === 3 ? 0 : v)), 'transparent-art');
assert.equal(transparentPalette.neutral, true, 'fully transparent artwork → neutral fallback (no crash)');
ok('2. green/blue/orange artwork → three distinct restrained deep palettes; achromatic → neutral');

// ============================================================
// 3. Palette contrast + the neutral fallback contract
// ============================================================
console.log('\n3. Palette contrast + neutral fallback');

function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrastRatio(fg: [number, number, number], bg: [number, number, number]): number {
  const l1 = relativeLuminance(...fg);
  const l2 = relativeLuminance(...bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function hslToTuple(h: number, s: number, l: number): [number, number, number] {
  const { r, g, b } = hslToRgb(h, s, l);
  return [r, g, b];
}

// The Mavero primary text (#f2fff8) on EVERY derived deep tone keeps a
// WCGG-large-text-safe (and then some) contrast ratio.
const textRgb: [number, number, number] = [242, 255, 248];
for (const palette of [greenPalette, bluePalette, orangePalette, grayPalette, NEUTRAL_FALLBACK]) {
  const m = palette.deep.match(/hsl\((\d+), (\d+)%, (\d+)%\)/)!;
  const deepRgb = hslToTuple(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
  const ratio = contrastRatio(textRgb, deepRgb);
  assert.ok(ratio >= 10, `${palette.neutral ? 'neutral' : 'hue ' + Math.round(palette.hue)}: text/deep contrast ${ratio.toFixed(1)}:1 ≥ 10:1`);
}

// The muted secondary text (#9db3aa) stays readable on the deep tone.
for (const palette of [greenPalette, bluePalette, orangePalette, NEUTRAL_FALLBACK]) {
  const m = palette.deep.match(/hsl\((\d+), (\d+)%, (\d+)%\)/)!;
  const deepRgb = hslToTuple(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
  const ratio = contrastRatio([157, 179, 170], deepRgb);
  assert.ok(ratio >= 4.5, `muted text/deep contrast ${ratio.toFixed(1)}:1 ≥ 4.5:1`);
}

// The NEUTRAL fallback is NOT the global background and NOT the global
// green accent — it is a deliberate cool slate.
assert.notEqual(NEUTRAL_FALLBACK.deep, 'rgb(5, 7, 8)', 'neutral fallback ≠ the fixed global background #050708');
assert.ok(!NEUTRAL_FALLBACK.deep.includes('156'), 'neutral fallback carries no global-green hue');
assert.equal(NEUTRAL_FALLBACK.neutral, true, 'neutral fallback flagged neutral');
ok('3. contrast verified on every palette; neutral fallback is a distinct cinematic slate');

// ============================================================
// 4. Palette cache — bounded LRU keyed by the artwork URL
// ============================================================
console.log('\n4. Palette cache (bounded LRU)');

clearPaletteCache();
function fakePalette(key: string): DetailPalette {
  return { ...NEUTRAL_FALLBACK, key };
}
// Fill beyond the bound (24) and verify eviction + LRU touch.
for (let i = 0; i < 30; i += 1) setCachedPalette(fakePalette(`art-${i}`));
assert.equal(getCachedPalette('art-29')?.key, 'art-29', 'the newest entry survives');
assert.equal(getCachedPalette('art-0'), undefined, 'the oldest entry was evicted (LRU bound)');
assert.ok(getCachedPalette('art-5') === undefined || getCachedPalette('art-6') !== undefined, 'eviction is FIFO-from-the-oldest beyond the bound');
// LRU touch: re-setting an entry refreshes it.
setCachedPalette(fakePalette('art-24'));
assert.equal(getCachedPalette('art-24')?.key, 'art-24', 'refreshed entry survives');
// Keyless palettes are never cached.
setCachedPalette(fakePalette(''));
assert.equal(getCachedPalette(''), undefined, 'empty-key palettes are not cached');
// Cached lookup returns the SAME object (instant back-nav).
assert.equal(getCachedPalette('art-29')?.deep, NEUTRAL_FALLBACK.deep, 'cache hit returns the stored palette');
clearPaletteCache();
ok('4. cache bounded at 24, LRU-evicting, keyed by the artwork URL');

// ============================================================
// 5. Race-guarded controller — stale extraction discarded
// ============================================================
console.log('\n5. Palette controller (stale-safety)');

// (a) Cache hit applies SYNCHRONOUSLY.
clearPaletteCache();
setCachedPalette(fakePalette('cached-art'));
{
  let applied: string | null | undefined;
  const controller = new DetailPaletteController((p) => { applied = p?.key ?? null; });
  controller.request('cached-art');
  assert.equal(applied, 'cached-art', 'cache hit applies synchronously');
  controller.dispose();
}

// (b) STALE EXTRACTION DISCARDED — rapid navigation: request A (slow),
// then request B; when A finally resolves it must NOT overwrite B.
{
  clearPaletteCache();
  let applied: string | null | 'none' = 'none';
  const pending = new Map<string, (value: DetailPalette | null) => void>();
  const extract = (url: string) => new Promise<DetailPalette | null>((resolve) => { pending.set(url, resolve); });
  const controller = new DetailPaletteController((p) => { applied = p?.key ?? null; });
  controller.request('art-A', extract);
  controller.request('art-B', extract);
  // art-B's extraction resolves FIRST.
  pending.get('art-B')!(fakePalette('art-B'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(applied, 'art-B', 'the newest request applies when it settles');
  // art-A's STALE extraction resolves LATER — it must be discarded.
  pending.get('art-A')!(fakePalette('art-A'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(applied, 'art-B', 'STALE extraction for the previous title is discarded (never applied)');
  controller.dispose();
  // After dispose, new requests are refused entirely (no extraction).
  let extractCalled = false;
  controller.request('art-C', (url) => {
    extractCalled = true;
    return Promise.resolve(fakePalette(url));
  });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(extractCalled, false, 'dispose() refuses new requests (no extraction runs)');
  assert.equal(applied, 'art-B', 'dispose() blocks every later application');
}

// (c) Empty key (= no artwork) immediately clears to null.
{
  let applied: string | null | 'none' = 'none';
  const controller = new DetailPaletteController((p) => { applied = p ? p.key : null; });
  controller.request('');
  assert.equal(applied, null, "'' requests clear the palette (no artwork → null → neutral CSS fallback)");
  controller.dispose();
}

// (d) SSR safety: extractArtworkPalette returns null without a window
// (importing/invoking the module on the server never crashes).
{
  const serverResult = await extractArtworkPalette('https://image.tmdb.org/t/p/w780/example.jpg');
  assert.equal(serverResult, null, 'extractArtworkPalette is SSR-safe (null without browser APIs)');
}
ok('5. cache-hit sync, stale discard, dispose block, empty-key clear, SSR safety');

// ============================================================
// 6. buildPaletteStyle — the scoped CSS custom-property contract
// ============================================================
console.log('\n6. Palette style (scoping contract)');

const style = buildPaletteStyle(greenPalette);
for (const token of ['--dp-deep', '--dp-deep-alt', '--dp-fade-mid', '--dp-surface', '--dp-accent', '--dp-accent-soft', '--dp-accent-border', '--dp-glow', '--dp-scrim']) {
  assert.ok(style.includes(`${token}:`), `style carries ${token}`);
}
assert.ok(!style.includes('--color-primary'), 'the style NEVER touches the global accent token');
// The DetailPage applies the style on its own root and nothing else.
assert.match(detailPage, /<div class="detail-page" style=\{paletteStyle\}>/, 'palette style is applied to the DetailPage ROOT only');
assert.match(detailPage, /const paletteStyle = \$derived\(palette \? buildPaletteStyle\(palette\) : ''\);/, 'style derives from the palette (empty until it lands → SSR/no-JS = neutral defaults)');
assert.doesNotMatch(detailPage, /document\.documentElement\.style/, 'no :root mutation — zero global theme leakage');
assert.doesNotMatch(detailPage, /localStorage\.setItem\('theme|sessionStorage\.setItem\('theme/, 'no persistent theme writes');
ok('6. style = 9 scoped --dp-* tokens on the detail root; global theme untouched');

// ============================================================
// 7. Artwork proxy endpoint — strict allowlist, image-only, bounded
// ============================================================
console.log('\n7. Artwork proxy (CORS-safe sampling path)');

assert.match(proxySrc, /image\.tmdb\.org/, 'allowlist includes the production artwork CDN');
assert.match(proxySrc, /images\.unsplash\.com/, 'allowlist includes the fixture imagery host');
assert.match(proxySrc, /pathname\.startsWith\('\/t\/p\/'\) && search === ''/, 'TMDB URLs: /t/p/ path, no query');
assert.match(proxySrc, /target\.protocol !== 'https:'[\s\S]*?return null/, 'https-only targets');
assert.match(proxySrc, /Unsupported artwork url/, 'non-allowlisted URLs rejected (no open proxy / SSRF)');
assert.match(proxySrc, /!contentType\.startsWith\('image\/'\)/, 'image-only passthrough');
assert.match(proxySrc, /MAX_IN_FLIGHT = 8/, 'bounded in-flight fan-out');
assert.match(proxySrc, /UPSTREAM_TIMEOUT_MS = 8000/, 'bounded upstream timeout');
assert.match(proxySrc, /'cache-control': 'public, max-age=604800, stale-while-revalidate=86400'/, 'immutable-artwork cache policy');
assert.match(proxySrc, /AbortController/, 'upstream aborts are wired');
// The palette engine uses the proxy as its CORS fallback.
assert.match(paletteSrc, /ARTWORK_PROXY_PATH = '\/api\/content\/artwork-proxy\?url='/, 'the sampler knows the proxy path');
assert.match(paletteSrc, /new Set<string>\(\['image\.tmdb\.org'\]\)/, 'TMDB pre-seeded as CORS-refusing (no doomed direct attempt)');
assert.match(paletteSrc, /image\.crossOrigin = 'anonymous'/, 'direct loads ask for CORS explicitly');
assert.match(paletteSrc, /typeof window === 'undefined' \|\| typeof document === 'undefined'/, 'browser APIs guarded for SSR');
ok('7. proxy: allowlist + image-only + bounded + cached; sampler wired to it');

// ============================================================
// 8. Approved cinematic-overlap structure
// ============================================================
console.log('\n8. Cinematic-overlap hero composition');

// The palette canvas flows BEHIND everything (no hard black rectangle).
assert.match(detailPage, /<div class="palette-canvas" class:active=\{paletteStyle !== ''\} aria-hidden="true"><\/div>/, 'the palette canvas layer exists (decorative)');
assert.match(detailPage, /\.palette-canvas \{[\s\S]*?position: absolute; inset: 0; z-index: 0;/, 'the canvas sits behind the content');
assert.match(detailPage, /opacity: 0;[\s\S]*?transition: opacity 480ms var\(--ease-out\);/, 'the palette fades in subtly (no flash)');
// The hero scrim lands on the palette deep tone (flows into the page).
assert.match(detailPage, /var\(--dp-deep\) 100%\)/, 'the hero scrim bottom fades INTO the derived deep tone');
// The page background is a flowing gradient → global base.
// MAV-23 supersession: the final stop is now a percentage (`#050708 100%`)
// so the palette-derived tint holds through Cast/Episodes and the tail
// ALWAYS lands on the global base regardless of page height — the same
// "flows into the global base" intent, no premature near-black plateau.
assert.match(detailPage, /background: linear-gradient\(180deg,[\s\S]*?#050708 100%\)/, 'the page backdrop flows from the derived tone into the global base');

// Poster OVERLAPS the backdrop on EVERY surface.
assert.match(detailPage, /\.hero-body \{[\s\S]*?margin-top: calc\(-1 \* clamp\(96px, 20vw, 150px\)\);/, 'the poster body overlaps the artwork (mobile base negative margin)');
assert.match(detailPage, /@media \(min-width: 1025px\) \{[\s\S]*?margin-top: calc\(-1 \* clamp\(180px, 22vw, 260px\)\);/, 'desktop deepens the overlap');
assert.match(detailPage, /@media \(max-width: 1024px\) and \(orientation: landscape\) and \(max-height: 480px\) \{[\s\S]*?\.hero-body \{ margin-top: -64px; \}/, 'landscape-short keeps the overlap bounded');
// Title + compact metadata BESIDE the poster (grid columns).
assert.match(detailPage, /\.hero-grid \{[\s\S]*?grid-template-columns: clamp\(100px, 27vw, 132px\) minmax\(0, 1fr\);/, 'mobile: poster column + metadata column side by side');
assert.match(detailPage, /\.hero-info \{[\s\S]*?grid-column: 2;[\s\S]*?grid-row: 1;/, 'the identity block sits BESIDE the poster');
assert.match(detailPage, /@media \(min-width: 1025px\) \{[\s\S]*?grid-template-columns: clamp\(230px, 20vw, 300px\) minmax\(0, 1fr\);/, 'desktop: wider poster column');
assert.match(detailPage, /\.poster-card \{[\s\S]*?grid-row: 1 \/ span 2;/, 'desktop: the poster spans the full hero block');
// Poster card: portrait aspect reserved (no shift), distinct card look.
assert.match(detailPage, /\.poster-card \{[\s\S]*?aspect-ratio: 2 \/ 3;/, 'poster card reserves its 2:3 aspect (no layout shift)');
assert.match(detailPage, /\.poster-card \{[\s\S]*?border-radius: 14px;[\s\S]*?box-shadow:/, 'poster card carries depth (radius + shadow)');
assert.match(detailPage, /onerror=\{\(\) => \(posterFailed = true\)\}/, 'poster failures tracked');
assert.match(detailPage, /poster-card-fallback" role="img" aria-label=/, 'missing poster renders a DELIBERATE fallback (never a broken icon)');
// Genre chips (bounded), synopsis preview.
assert.match(detailPage, /class="genre-chip"/, 'hero genres render as compact CHIPS');
ok('8. overlap composition: canvas flow, poster overlap, side-by-side identity, deliberate fallbacks');

// ============================================================
// 9. Dynamic palette wiring in the page (async, non-blocking, scoped)
// ============================================================
console.log('\n9. Palette wiring + title-change reactivity');

assert.match(detailPage, /import \{ DetailPaletteController, buildPaletteStyle, type DetailPalette \} from '\$lib\/client\/detail\/palette';/, 'the page imports the palette engine');
assert.match(detailPage, /const paletteController = new DetailPaletteController\(\(next\) => \{\s*palette = next;\s*\}\);/, 'the controller applies palettes through state');
assert.match(detailPage, /const paletteSource = \$derived\(item\.backdropSmall \|\| item\.backdrop \|\| item\.posterSmall \|\| item\.poster \|\| ''\);/, 'extraction source: BACKDROP first, poster as the fallback');
assert.match(detailPage, /\$effect\(\(\) => \{[\s\S]*?const source = paletteSource;[\s\S]*?paletteController\.request\(source\);\s*\}\);/, 'the palette request re-runs with the CURRENT artwork (client-side nav)');
assert.match(detailPage, /paletteController\.dispose\(\);/, 'teardown disposes the controller (nothing outlives the page)');
// The page renders BEFORE the palette (non-blocking).
assert.match(detailPage, /const paletteStyle = \$derived\(palette \? buildPaletteStyle\(palette\) : ''\);/, "empty style until extraction lands — title/poster/Play never wait for it");
// Neutral CSS defaults (NOT black, NOT the global accent) pre-palette.
assert.match(detailPage, /--dp-deep: hsl\(210, 16%, 7%\);/, 'neutral cinematic slate is the pre-palette default');
assert.match(detailPage, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.palette-canvas,/, 'reduced-motion disables the palette transition');
ok('9. wiring: backdrop-first source, non-blocking apply, scoped dispose, neutral pre-palette');

// ============================================================
// 10. Metadata deduplication (hero vs More Details)
// ============================================================
console.log('\n10. Metadata deduplication');

// The hero shows rating/year/runtime-or-counts/certification...
assert.match(detailPage, /\{#if !isSeriesLike && item\.runtime\}[\s\S]*?item\.runtime\}[\s\S]*?\{:else if isSeriesLike && item\.seasons\}/, 'hero meta: movie runtime / series season-or-episode count');
assert.match(detailPage, /\{#if item\.maturity\}<span class="dot"><\/span><span class="maturity">\{item\.maturity\}<\/span>\{\/if\}/, 'hero meta: certification chip');
assert.match(detailPage, /\{#if item\.year > 0\}[\s\S]*?\{item\.year\}/, 'hero meta: concise year');
// ...and More Details shows ONLY the complementary facts.
const factRowsSrc = detailPage.match(/const factRows = \$derived\.by\(\(\) => \{[\s\S]*?\n  \}\);/)![0];
assert.match(factRowsSrc, /if \(item\.releaseDate\) rows\.push\(\{ label: isSeriesLike \? 'First aired' : 'Release date', value: formatDate\(item\.releaseDate\) \}\);/, 'More Details: FULL release date (hero shows the year only)');
assert.match(factRowsSrc, /if \(!isSeriesLike && item\.director\) rows\.push\(\{ label: 'Director', value: item\.director \}\);/, 'More Details: director');
assert.match(factRowsSrc, /if \(isSeriesLike && item\.creators\?\.length\) rows\.push\(\{ label: 'Creators', value: item\.creators\.join\(', '\) \}\);/, 'More Details: creators');
assert.match(factRowsSrc, /if \(language\) rows\.push\(\{ label: 'Original language', value: language \}\);/, 'More Details: original language');
assert.match(factRowsSrc, /if \(isSeriesLike && item\.seasons && item\.episodes\) rows\.push\(\{ label: 'Episodes', value: String\(item\.episodes\) \}\);/, 'More Details: the episode count the hero season-count leaves out');
assert.doesNotMatch(factRowsSrc, /label: 'Certification'/, 'NO certification row (the hero chip already shows it)');
assert.doesNotMatch(factRowsSrc, /label: 'Genres'/, 'NO genres row (the hero chips already show them)');
assert.doesNotMatch(factRowsSrc, /label: 'Runtime'/, 'NO runtime row (the hero meta already shows it)');
assert.doesNotMatch(factRowsSrc, /label: 'Seasons'/, 'NO seasons row (the hero meta already shows it)');

// Functional truth table mirroring the dedup policy.
type FactItem = { releaseDate?: string; year: number; runtime: string; seasons?: number; episodes?: number; maturity?: string; director?: string; creators?: string[]; originalLanguage?: string };
function heroShows(item: FactItem, seriesLike: boolean) {
  return {
    year: item.year > 0,
    runtime: !seriesLike && Boolean(item.runtime),
    seasons: seriesLike && Boolean(item.seasons),
    episodes: seriesLike && !item.seasons && Boolean(item.episodes),
    certification: Boolean(item.maturity)
  };
}
function moreDetailsRows(item: FactItem, seriesLike: boolean, formatDate: (iso?: string) => string, languageName: (code?: string) => string) {
  const rows: string[] = [];
  if (item.releaseDate) rows.push(seriesLike ? 'First aired' : 'Release date');
  if (!seriesLike && item.director) rows.push('Director');
  if (seriesLike && item.creators?.length) rows.push('Creators');
  if (languageName(item.originalLanguage)) rows.push('Original language');
  if (seriesLike && item.seasons && item.episodes) rows.push('Episodes');
  return rows;
}
const hero = heroShows({ year: 2024, runtime: '2h 08m', seasons: 3, episodes: 24, maturity: '16+' }, true);
assert.deepEqual(hero, { year: true, runtime: false, seasons: true, episodes: false, certification: true }, 'hero truth table (series with seasons)');
const rows = moreDetailsRows({ year: 2024, runtime: '2h 08m', seasons: 3, episodes: 24, releaseDate: '2024-03-07', originalLanguage: 'hi' }, true, () => '07 Mar 2024', () => 'Hindi');
assert.deepEqual(rows, ['First aired', 'Original language', 'Episodes'], 'More Details completes the NON-hero facts only (absent creators → no row)');
const rowsWithCreators = moreDetailsRows({ year: 2024, runtime: '2h 08m', seasons: 3, episodes: 24, releaseDate: '2024-03-07', originalLanguage: 'hi', creators: ['A. Creator'] }, true, () => '07 Mar 2024', () => 'Hindi');
assert.deepEqual(rowsWithCreators, ['First aired', 'Creators', 'Original language', 'Episodes'], 'present creators add their row');
const movieRows = moreDetailsRows({ year: 2024, runtime: '2h 08m', releaseDate: '2024-03-07', director: 'A. Director' }, false, () => '07 Mar 2024', () => '');
assert.deepEqual(movieRows, ['Release date', 'Director'], 'movie More Details: full date + director (runtime stays in the hero)');
ok('10. strict dedup: no fact appears in both the hero and More Details');

// ============================================================
// 11. Rectangular cast cards + two-column More Details grid
// ============================================================
console.log('\n11. Rectangular cast + two-column details grid');

// RECTANGULAR portrait cards — the circular avatars are gone.
assert.match(detailPage, /\.cast-photo \{[\s\S]*?aspect-ratio: 2 \/ 3;/, 'cast photos are 2:3 PORTRAITS');
assert.doesNotMatch(detailPage, /\.cast-photo \{[^}]*border-radius:\s*50%/, 'cast photos are NOT circular');
assert.match(detailPage, /\.cast-card \{[\s\S]*?flex: 0 0 clamp\(108px, 26vw, 136px\);/, 'cast cards keep a consistent width (responsive clamp)');
assert.match(detailPage, /\.cast-photo \{[\s\S]*?object-position: center 20%;/, 'portrait crop biases to faces');
assert.match(detailPage, /\.cast-name \{[\s\S]*?-webkit-line-clamp: 2; line-clamp: 2;/, 'actor names wrap to two lines (not over-truncated)');
assert.match(detailPage, /class="cast-photo cast-photo-fallback"/, 'the initial fallback persists (graceful missing photo)');
assert.match(detailPage, /\.cast-rail \{[\s\S]*?overflow-x: auto;/, 'the cast rail scrolls horizontally');
assert.doesNotMatch(detailPage, /class="cast-rail" role="list"[\s\S]*?item\.director/, 'crew members are never mixed into the cast rail');

// The More Details GRID: two columns on mobile, expanding on larger screens.
assert.match(detailPage, /<section class="details-section" aria-labelledby="details-heading">/, 'the More Details section exists');
assert.match(detailPage, /<h2 class="section-h" id="details-heading">More Details<\/h2>/, 'the section is clearly titled More Details');
assert.match(detailPage, /\.details-grid \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/, 'MOBILE: two columns');
assert.match(detailPage, /@media \(min-width: 1025px\) \{[\s\S]*?\.details-grid \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/, 'desktop expands to three columns');
assert.match(detailPage, /@media \(min-width: 1900px\) \{[\s\S]*?\.details-grid \{[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/, 'large displays expand to four');
assert.match(detailPage, /\.fact-value \{[\s\S]*?overflow-wrap: anywhere;/, 'long/multilingual values wrap safely');
assert.doesNotMatch(detailPage, /class="facts-grid"/, 'the old overview fact list is gone');
ok('11. rectangular cast (2:3, no circles) + responsive 2/3/4-column details grid');

// ============================================================
// 12. Compact provider availability (hero actions area)
// ============================================================
console.log('\n12. Compact provider indicator');

assert.match(detailPage, /class="provider-strip" aria-label=\{`Available on \$\{heroProviderNames\}`\}/, 'the compact provider strip sits in the HERO (near the actions)');
assert.match(detailPage, /const MAX_HERO_PROVIDERS = 3;/, 'at most 3 provider logos + an overflow count');
assert.match(detailPage, /const heroProviders = \$derived\(\(item\.streamingProviders \?\? \[\]\)\.filter\(\(provider\) => provider\.name\?\.trim\(\)\)\);/, 'only GENUINE provider metadata renders the strip');
assert.match(detailPage, /\{#if heroProviderOverflow > 0\} <span class="provider-more">\+\{heroProviderOverflow\}<\/span>\{\/if\}/, 'overflow surfaces as a count');
assert.match(detailPage, /\{#if heroProviders\.length\}[\s\S]*?class="provider-strip"/, 'empty provider data renders NOTHING (no invented availability)');
assert.match(detailPage, /\.provider-strip \{[\s\S]*?margin-top: 14px;/, 'the strip sits BELOW the action rows (never blocks playback)');
assert.doesNotMatch(detailPage, /streaming-heading/, 'the old separate provider section is GONE (it added nothing beyond the compact strip)');
assert.doesNotMatch(detailPage, /class="streaming-provider"/, 'no large redundant provider cards remain');
assert.doesNotMatch(appCss, /mav22-provider/, 'no global CSS additions for the strip (component-scoped)');
ok('12. compact strip: genuine data, bounded, after the actions, section duplication removed');

// ============================================================
// 13. Content-type labels — the approved vocabulary
// ============================================================
console.log('\n13. Content-type labels');

const labelSrc = detailPage.match(/const contentTypeLabel = \$derived\.by\(\(\) => \{[\s\S]*?\n  \}\);/)![0];
assert.match(labelSrc, /return format === 'movie' \? 'Anime Movie' : 'Anime Series';/, 'anime titles: Anime Movie / Anime Series');
assert.match(labelSrc, /if \(type === 'movie'\) return 'Movie';/, 'plain movies: Movie');
assert.match(labelSrc, /return 'TV Series';/, 'plain series: TV Series');
function labelFor(isAnime: boolean, type: string, animeFormat?: 'movie' | 'series'): string {
  if (isAnime) {
    const format = animeFormat ?? (type === 'movie' ? 'movie' : 'series');
    return format === 'movie' ? 'Anime Movie' : 'Anime Series';
  }
  if (type === 'movie') return 'Movie';
  if (type === 'anime') return 'Anime';
  return 'TV Series';
}
assert.equal(labelFor(true, 'anime', 'movie'), 'Anime Movie', 'anime movie → Anime Movie');
assert.equal(labelFor(true, 'anime', 'series'), 'Anime Series', 'anime series → Anime Series');
assert.equal(labelFor(false, 'movie'), 'Movie', 'movie → Movie');
assert.equal(labelFor(false, 'series'), 'TV Series', 'series → TV Series');
assert.equal(labelFor(true, 'movie'), 'Anime Movie', 'anime-flagged movie route → Anime Movie (format fallback)');
ok('13. labels: Movie / TV Series / Anime Movie / Anime Series');

// ============================================================
// 14. Overview — full synopsis, no duplicate truncated copy
// ============================================================
console.log('\n14. Overview section (no duplicate synopsis)');

// The hero carries a CSS-clamped 2-line PREVIEW only.
assert.match(detailPage, /\.detail-desc \{[\s\S]*?-webkit-line-clamp: 2; line-clamp: 2;/, 'hero synopsis = a 2-line preview');
// Overview is a clearly titled section with the FULL synopsis.
assert.match(detailPage, /<h2 class="section-h" id="overview-heading">Overview<\/h2>/, 'Overview section present');
assert.match(detailPage, /\.overview-text \{[\s\S]*?-webkit-line-clamp: 4; line-clamp: 4;/, 'Overview clamps at 4 lines until expanded');
assert.match(detailPage, /\{overviewExpanded \? 'Show Less' : 'Show More'\}/, 'Show more/Show less toggles');
assert.match(detailPage, /const hasLongOverview = \$derived\(item\.description\.length > 280\);/, 'expansion only for genuinely long synopses');
assert.match(detailPage, /class:expanded=\{overviewExpanded\}/, 'the expansion class drives the unclamp');
// The old duplicate (facts inside Overview) is gone — More Details owns them.
assert.doesNotMatch(detailPage.match(/<section class="overview-section"[\s\S]*?<\/section>/)![0], /factRows/, 'Overview renders NO fact rows (dedup with More Details)');
ok('14. Overview = full expandable synopsis; hero preview is CSS-clamped, never a second section');

// ============================================================
// 15. You May Also Like — portrait recommendation cards
// ============================================================
console.log('\n15. Recommendation cards');

assert.match(detailPage, /<h2 class="section-h" id="recs-heading">You may also like<\/h2>/, 'the rail keeps its title');
assert.match(detailPage, /class="rec-card"/, 'dedicated portrait recommendation cards');
assert.match(detailPage, /\.rec-poster \{[\s\S]*?aspect-ratio: 2 \/ 3;/, 'stable 2:3 poster dimensions');
assert.match(detailPage, /\.rec-title \{[\s\S]*?-webkit-line-clamp: 2; line-clamp: 2;/, 'titles wrap to two lines');
assert.match(detailPage, /\{#if rec\.year > 0\}<span>\{rec\.year\}<\/span>\{\/if\}/, 'release year renders when present');
assert.match(detailPage, /\{#if rec\.rating > 0\}<span class="rec-rating">/, 'rating renders when present (never a false zero)');
assert.match(detailPage, /\{:else\}[\s\S]*?rec-poster-fallback/, 'missing posters fall back gracefully');
assert.match(detailPage, /href=\{appendReturnTo\(`\/\$\{rec\.type\}\/\$\{rec\.id\}`, `\$\{page\.url\.pathname\}\$\{page\.url\.search\}`\)\}/, 'navigation preserves the origin (appendReturnTo)');
assert.match(detailPage, /\.recs-row \{[\s\S]*?overflow-x: auto;/, 'the rec rail scrolls horizontally (touch)');
assert.match(detailPage, /\{:else if recommendationState === 'loading'\}[\s\S]*?aria-busy="true"/, 'skeleton while loading (never before the primary title is ready)');
assert.match(detailPage, /recommendationState = 'failed';/, 'failed loads settle silently (section hidden)');
assert.match(detailPage, /\{#each recommendations as rec \(rec\.id\)\}/, 'recs are keyed (no duplicate of the current title unless the API returns it)');
ok('15. portrait rec cards: stable dimensions, honest metadata, preserved navigation');

// ============================================================
// 16. Preserved contracts — playback, download, Watching, Share,
//     Trailer, seasons, back policy, SEO, title reactivity
// ============================================================
console.log('\n16. Preserved behavior contracts');

// Action hierarchy (stateful, dominant).
assert.match(detailPage, /const playLabel = \$derived\(\s*isSeriesLike && resumeEpisode \? 'Continue Watching'\s*: !isSeriesLike && hasActiveProgress \? 'Resume'\s*: 'Play'\s*\);/, 'Play / Resume / Continue Watching label policy preserved');
assert.match(detailPage, /\.play-btn \{[\s\S]*?flex: 1 1 62%;[\s\S]*?min-height: 52px;/, 'the primary action remains the dominant surface');
assert.match(detailPage, /class="secondary-actions">[\s\S]*?statusLabel\(watchlistStatus\)[\s\S]*?Share[\s\S]*?Trailer/, 'the approved secondary row: Watching · Share · Trailer');
assert.match(detailPage, /const downloadMediaType = \$derived\(\(type === 'movie' \|\| \(item\.isAnime && item\.animeFormat === 'movie'\)\) \? 'movie' : 'tv' as DownloadMediaType\);/, 'download media-type mapping preserved (movie/anime-movie → movie)');
assert.match(detailPage, /function openEpisodeDownloadSheet\(season: number, episode: number\) \{[\s\S]*?downloadTargetSeason = season;[\s\S]*?downloadTargetEpisode = episode;/, 'episode downloads target the EXACT clicked episode');
assert.match(detailPage, /onDownload=\{openEpisodeDownloadSheet\}/, 'SeasonEpisodes download wiring preserved');
assert.match(detailPage, /\{#if isSeriesLike\}[\s\S]*?<SeasonEpisodes/, 'Seasons & Episodes render for series-like titles (TV + anime series)');
assert.match(detailPage, /watchType=\{type === 'anime' \? 'anime' : 'series'\}/, 'SeasonEpisodes watchType mapping preserved');
// Back policy + SEO + trailer a11y (byte-preserved behaviors).
assert.match(detailPage, /const validReturnTo = returnTo\?\.startsWith\('\/'\) && !returnTo\.startsWith\('\/\/'\) \? returnTo : null;/, 'back: from-validation preserved');
assert.match(detailPage, /const fallbackDestination = validReturnTo \?\? '\/discover';/, 'back: fallback destination preserved');
assert.match(detailPage, /navigateBackOr\(\(\) => \{/, 'back: shared policy preserved');
assert.match(detailPage, /const watchHref = \$derived\(appendReturnTo\(watchPath, `\$\{page\.url\.pathname\}\$\{page\.url\.search\}\$\{page\.url\.hash\}`\)\);/, 'watch link carries the origin');
assert.match(detailPage, /<link rel="canonical" href=\{canonicalUrl\} \/>/, 'canonical URL preserved');
assert.match(detailPage, /<script type="application\/ld\+json">\{structuredData\}<\/script>/, 'structured data preserved');
// MAV-23 supersession: the inline player has no dialog chrome — focus
// returns to the Trailer toggle on stop (the same "restore focus on
// close" intent; the toggle IS the trigger now).
assert.match(detailPage, /trailerToggle\?\.focus\(\);/, 'trailer stop restores focus (to the Trailer toggle)');
assert.match(detailPage, /querySelector<HTMLElement>\('\.trailer-fs-btn'\)/, 'trailer start moves focus to the reachable fullscreen control');
assert.match(detailPage, /return \(\) => \{\s*active = false;/, 'onMount cleanup (active guard) intact');
assert.match(detailPage, /void loadDownloadProviders\(\)/, 'downloader prefetch (fire-and-forget) intact');
assert.doesNotMatch(detailPage, /canAccessAdultContent/, 'no duplicated adult guard (SSR remains the authority)');
// Title-scoped reactivity: client-side detail → detail navigation.
assert.match(detailPage, /\$effect\(\(\) => \{[\s\S]*?void item\.id;[\s\S]*?void type;[\s\S]*?void isSeriesLike;[\s\S]*?void loadProgressState\(\);/, 'progress/watchlist state reloads with the displayed title');
assert.match(detailPage, /if \(forId !== item\.id\) return;/, 'stale recommendation responses are dropped');
assert.match(detailPage, /heroArtworkFailed = false;[\s\S]*?posterFailed = false;/, 'artwork failure flags reset on title change (no poisoned next title)');
ok('16. playback/download/Watching/Share/Trailer/seasons/back/SEO preserved; title-scoped reactivity added');

// ============================================================
// 17. Responsive composition + a11y hardening
// ============================================================
console.log('\n17. Responsive + a11y');

assert.match(detailPage, /min-height: clamp\(440px, 78vh, 760px\)/, 'the hero reserves its space at every surface (no shift)');
assert.match(detailPage, /\.hero \{ min-height: auto; height: auto; \}/, 'landscape-short collapses the hero');
assert.match(detailPage, /\.poster-card \{ grid-row: 1 \/ span 2;/, 'desktop full-height poster');
// MAV-23 supersessions (Fix 1 + Fix 6): mobile Play shares the dominant
// row with Download (62/38, both ≥52px) so the provider chip reaches the
// initial viewport; the page bottom padding dropped from 96px/110px to a
// compact clamp + safe-area (no obscured last cards).
assert.match(detailPage, /@media \(max-width: 640px\) \{[\s\S]*?\.play-btn \{ flex: 1 1 62%; min-height: 52px;/, 'mobile Play keeps a ≥52px dominant target (shared primary row)');
assert.match(detailPage, /\.back-btn \{[\s\S]*?top: calc\(1[24]px \+ env\(safe-area-inset-top\)\);/, 'back button respects the safe-area inset');
assert.match(detailPage, /padding-bottom: clamp\(36px, 5vw, 72px\);/, 'bottom clearance (compact, Android nav bars safe)');
assert.match(detailPage, /@media \(max-width: 640px\) \{[\s\S]*?padding-bottom: calc\(36px \+ env\(safe-area-inset-bottom, 0px\)\);/, 'mobile bottom clearance + safe-area');
assert.match(detailPage, /\.hero-grid \{[\s\S]*?minmax\(0, 1fr\)/, 'the info column can never overflow (minmax 0)');
assert.match(detailPage, /\.provider-names \{[\s\S]*?overflow-wrap: anywhere;/, 'provider names wrap safely');
assert.match(detailPage, /\.palette-canvas,[\s\S]*?transition: none !important;/, 'reduced-motion: palette transition disabled');
assert.match(detailPage, /aria-hidden="true"><\/div>/, 'decorative layers are aria-hidden');
assert.match(detailPage, /<h1 class="detail-title">\{item\.title\}<\/h1>/, 'semantic h1 for the title');
assert.match(detailPage, /aria-label=\{playSubLabel \? `\$\{playLabel\} — season \$\{resumeEpisode\?\.season\}, episode \$\{resumeEpisode\?\.episode\}` : `\$\{playLabel\} \$\{item\.title\}`\}/, 'the Play action announces the exact behavior');
assert.doesNotMatch(detailPage, /<a [^>]*role="listitem"/, 'no invalid interactive→noninteractive roles');
ok('17. responsive overlap at every surface; focus/safe-area/reduced-motion hardening');

console.log(`\nMAV-22 Detail Page 3.0 tests passed (${passed} check groups).`);


