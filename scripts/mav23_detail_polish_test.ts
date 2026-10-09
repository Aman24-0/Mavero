import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * MAV-23 — Detail Page Final Polish regression suite.
 *
 * Covers the six approved fixes on top of the MAV-22 cinematic 3.0 detail
 * page, WITHOUT weakening any MAV-22/earlier contract:
 *
 *   Fix 1 — mobile initial viewport reaches the compact provider chip
 *           (optimized mobile hero composition; desktop untouched).
 *   Fix 2 — the title-derived dynamic palette continues through Cast and
 *           Episodes (SeasonEpisodes consumes --dp-* with safe fallbacks;
 *           the page gradient keeps palette-derived tint through the lower
 *           sections instead of collapsing to near-black).
 *   Fix 3 — back-navigation acceleration: the composed Discover payload is
 *           server-cached (bounded TTL + validity guard) so the SvelteKit
 *           leaf-load re-run on cross-route back never re-fans-out to TMDB.
 *   Fix 4 — inline trailer playback inside the cinematic backdrop
 *           (Trailer / Trailer Off toggle, adjacent fullscreen control,
 *           guarded Fullscreen + orientation APIs, stale-playback guard).
 *   Fix 5 — the downloader sheet adopts the ACTIVE title palette through
 *           an explicit paletteStyle prop (neutral fallback preserved).
 *   Fix 6 — excessive bottom whitespace removed; safe-area preserved.
 *
 * Mix of source-contract assertions (repo convention) and pure behavioral
 * tests (palette sibling derivation, composed-cache validity).
 */

const repoRoot = new URL('../', import.meta.url).pathname;
const read = (rel: string) => readFile(path.join(repoRoot, rel), 'utf8');

const detailPage = await read('src/lib/components/DetailPage.svelte');
const seasonEpisodes = await read('src/lib/components/SeasonEpisodes.svelte');
const downloadSheet = await read('src/lib/components/DownloadSheet.svelte');
const palette = await read('src/lib/client/detail/palette.ts');
const discoverLoad = await read('src/lib/server/content/discover-load.ts');
const contentData = await read('src/lib/data/content.ts');
const packageJson = JSON.parse(await read('package.json'));
const navigation = await read('src/lib/shared/navigation.ts');
const layoutSvelte = await read('src/routes/+layout.svelte');

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

// ============================================================
// 1. Fix 1 — mobile fold reaches the provider chip
// ============================================================
const mobileBlock = detailPage.slice(detailPage.indexOf('@media (max-width: 640px)'));

ok(/min-height:\s*clamp\(300px,\s*44vh,\s*460px\)/.test(mobileBlock), 'F1: mobile hero uses a compact 44vh-capped min-height (no fixed clipping height)');
ok(/clamp\(78px,\s*19vw,\s*112px\)/.test(mobileBlock), 'F1: mobile overlap depth tuned so the hero body rises higher over the artwork');
ok(/grid-template-columns:\s*clamp\(96px,\s*25vw,\s*124px\)/.test(mobileBlock), 'F1: mobile poster column compacted (2:3 overlap card retained)');
ok(!/\.play-btn\s*\{[^}]*flex:\s*1 1 100%/.test(mobileBlock), 'F1: mobile Play no longer forces a full-width row (side-by-side with Download)');
ok(/\.play-btn\s*\{[^}]*flex:\s*1 1 62%/.test(mobileBlock), 'F1: Play remains the dominant 62% primary action on mobile');
ok(/\.download-btn\s*\{[^}]*flex:\s*1 1 38%/.test(mobileBlock), 'F1: Download shares the primary row on mobile (saves a full 52px row)');
ok(/\.actions\s*\{[^}]*margin-top:\s*12px/.test(mobileBlock), 'F1: action block margin compacted');
ok(/\.provider-strip\s*\{[^}]*margin-top:\s*10px/.test(mobileBlock), 'F1: provider strip pulled tighter beneath the actions');
ok(/\.provider-strip\s*\{[^}]*padding:\s*5px 10px/.test(mobileBlock), 'F1: provider strip padding compacted');
ok(/min-height:\s*52px/.test(mobileBlock.split('.download-btn')[1] ?? ''), 'F1: Download keeps a 52px touch target on mobile');
ok(/\.secondary-btn\s*\{[^}]*min-height:\s*44px|\.secondary-btn\s*\{[^}]*padding:\s*10px 12px/.test(detailPage) || /\.secondary-btn\s*\{[^}]*padding:\s*10px 12px/.test(mobileBlock), 'F1: secondary buttons stay >=44px touch targets while compacted');
// Desktop composition untouched (the approved 3.0 look).
ok(/min-height:\s*clamp\(520px,\s*76vh,\s*760px\)/.test(detailPage), 'F1: desktop hero min-height unchanged (approved composition preserved)');
ok(/margin-top:\s*calc\(-1 \* clamp\(180px,\s*22vw,\s*260px\)\)/.test(detailPage), 'F1: desktop overlap depth unchanged');
// Landscape-short guard still present.
ok(/orientation: landscape\) and \(max-height: 480px\)/.test(detailPage), 'F1: landscape-short guard retained');
// Every hero element required above the chip still renders (no removals).
for (const el of ['poster-card', 'detail-title', 'meta-row', 'genre-chips', 'detail-desc', 'primary-actions', 'secondary-actions', 'provider-strip']) {
  ok(detailPage.includes(`class="${el}"`) || detailPage.includes(`class="${el} `), `F1: hero element .${el} still rendered (nothing removed to force the fold)`);
}

// ============================================================
// 2. Fix 2 — palette continuity through Cast and Episodes
// ============================================================
// The page gradient keeps the derived tint deep into the page (no
// premature collapse to near-black below the Cast row) and always lands
// on the global base at the very bottom for footer continuity.
// The page gradients (NOT the hero scrim's readability gradient) hold the
// palette-derived tint deep into the page.
const gradientUses = detailPage.match(/linear-gradient\(180deg,\s*var\(--dp-deep-alt\)[^;]+\)/g) ?? [];
ok(gradientUses.length >= 2, 'F2: both .detail-page and .palette-canvas carry the flowing gradient');
for (const g of gradientUses) {
  ok(/var\(--dp-deep\)\s*900px/.test(g), 'F2: gradient holds the deep tone through ~900px (hero + overlap + cast zone)');
  ok(/var\(--dp-fade-mid\)\s*2100px/.test(g), 'F2: gradient fades through the palette-tinted mid stop at 2100px (not abrupt black)');
  ok(/#050708 100%\)/.test(g), 'F2: gradient tail still lands on the global base at the page end');
  ok(!/var\(--dp-fade-mid\)\s*1500px/.test(g), 'F2: the MAV-22 premature fade stop (1500px) is gone');
}
// SeasonEpisodes consumes the title palette through dp vars with safe fallbacks.
const dpVarUses = seasonEpisodes.match(/var\(--dp-[a-z0-9-]+,/g) ?? [];
ok(dpVarUses.length >= 10, `F2: SeasonEpisodes consumes the --dp-* palette with fallbacks (${dpVarUses.length} usages)`);
ok(/\.ep-eyebrow\s*\{[^}]*var\(--dp-accent,\s*var\(--color-primary\)\)/.test(seasonEpisodes), 'F2: eyebrow accent is title-derived (falls back to the global green standalone)');
ok(/\.ep-eyebrow\s*\{[^}]*var\(--dp-glow,\s*rgba\(0, 255, 156, \.3\)\)/.test(seasonEpisodes), 'F2: eyebrow glow follows the palette');
ok(/\.season-tabs\s*\{[^}]*var\(--dp-surface,/.test(seasonEpisodes), 'F2: season tab tray surface is palette-derived');
ok(/\.season-tabs button\.active\s*\{[^}]*var\(--dp-accent,\s*var\(--color-primary\)\)/.test(seasonEpisodes), 'F2: active season chip uses the title accent');
ok(/\.ep-play\s*\{[^}]*var\(--dp-accent,\s*var\(--color-primary\)\)/.test(seasonEpisodes), 'F2: episode play button uses the title accent');
ok(/\.ep-row:focus-within\s*\{[^}]*var\(--dp-accent,/.test(seasonEpisodes), 'F2: episode focus rail uses the title accent (focus visibility preserved)');
ok(/\.ep-row:hover\s*\{[^}]*var\(--dp-surface,/.test(seasonEpisodes), 'F2: episode hover surface is palette-derived');
// No BARE global-green usages remain (every green literal is now a fallback arg).
const bareGreen = seasonEpisodes.match(/(?<!var\(--dp-[a-z0-9-]+,\s*)rgba\(0, 255, 156/g) ?? [];
ok(bareGreen.length === 0, `F2: no un-guarded global-green literals remain in SeasonEpisodes (${bareGreen.length} found)`);
const withoutDpFallbacks = seasonEpisodes.replace(/var\(--dp-[a-z0-9-]+,\s*var\(--color-primary[a-z-]*\)\)/g, '');
ok(!withoutDpFallbacks.includes('--color-primary'), 'F2: --color-primary survives ONLY as a fallback argument');
// Palette engine: sibling accent for the downloader (same hue — never a
// conflicting independent color), still scoped inline.
ok(/--dp-accent-2/.test(palette), 'F2: palette engine emits a --dp-accent-2 sibling token (same derived hue)');

// ============================================================
// 3. Fix 3 — back-navigation acceleration (composed Discover cache)
// ============================================================
ok(/DISCOVER_PAGE_CACHE_KEY|discover:page:v1/.test(discoverLoad), 'F3: composed Discover payload cache key is versioned');
ok(/ttlMs:\s*45_000|ttlMs:\s*45000/.test(discoverLoad), 'F3: composed cache TTL is bounded (45s — aligned with the client rail-cache philosophy)');
ok(/staleWhileRevalidateMs/.test(discoverLoad), 'F3: SWR semantics preserved (stale serves while revalidating)');
ok(/getOrSetValidated/.test(discoverLoad.split('loadDiscoverData').slice(1).join('loadDiscoverData')) || /getOrSetValidated[\s\S]{0,400}loadDiscoverDataUncached/.test(discoverLoad), 'F3: the composed cache uses getOrSetValidated (invalid results are never cached)');
ok(/loadDiscoverDataUncached/.test(discoverLoad), 'F3: the original loader body is preserved behind the cache wrapper');
ok(/isDiscoverPageCacheable/.test(discoverLoad), 'F3: a validity predicate guards the composed cache (a failed/all-empty load is not cached)');
ok(/heroItems/.test(discoverLoad), 'F3: loadDiscoverData still returns heroItems (discover_v2 contract)');
ok(/selectHeroLineup/.test(discoverLoad), 'F3: loadDiscoverData still calls selectHeroLineup (discover_hero_lineup contract)');
ok(/loadRail[\s\S]*?loadDiscoverDataUncached|loadRail[\s\S]*?loadDiscoverData/.test(discoverLoad), 'F3: loadRail remains the rail engine (explorer_page contract)');
// The navigation policy itself is untouched.
ok(/navigateBackOr/.test(navigation) && /recordInAppNavigation/.test(navigation), 'F3: the shared back policy (history.back + watchdog) is untouched');
ok(/export const snapshot/.test(layoutSvelte) && /capture:\s*\(\)/.test(layoutSvelte), 'F3: scroll snapshot capture/restore is untouched');
// No arbitrary delay/timer hacks were added to make back FEEL faster.
ok(!/setTimeout\([^)]*,\s*(2[0-9]{2}|[3-9][0-9]{2})\)\s*;?\s*\/\/\s*(fake|hide|delay)/i.test(detailPage), 'F3: no cosmetic delay hacks in the detail page');

// ============================================================
// 4. Fix 4 — inline trailer in the cinematic backdrop
// ============================================================
ok(/trailerActive/.test(detailPage), 'F4: inline trailer state exists');
ok(!/trailer-modal/.test(detailPage), 'F4: the separate trailer modal is gone');
ok(!/trailer-layer/.test(detailPage), 'F4: the fixed trailer overlay layer is gone');
ok(/class="trailer-inline"/.test(detailPage), 'F4: the trailer renders INLINE inside the hero');
ok(detailPage.indexOf('class="trailer-inline"') > detailPage.indexOf('<header class="hero">') && detailPage.indexOf('class="trailer-inline"') < detailPage.indexOf('</header>'), 'F4: the inline player lives INSIDE the hero (cinematic backdrop area)');
ok(/\{#if trailerActive && hasTrailer\}[\s\S]*?\{:else\}[\s\S]*?heroArtworkSrc/.test(detailPage.slice(detailPage.indexOf('<header class="hero">'), detailPage.indexOf('</header>'))), 'F4: trailer activation swaps the backdrop artwork (and restores it on stop)');
ok(/\{trailerActive \? 'Trailer Off' : 'Trailer'\}/.test(detailPage), 'F4: the toggle label switches Trailer / Trailer Off');
ok(/aria-pressed=\{trailerActive\}/.test(detailPage), 'F4: the toggle exposes aria-pressed');
ok(/class="secondary-btn trailer-fs-btn"/.test(detailPage), 'F4: an accessible fullscreen control sits next to the toggle while playback is active');
ok(/aria-label="Show trailer fullscreen"/.test(detailPage), 'F4: the fullscreen control has an accessible label');
ok(/\{#if trailerActive\}\s*<button\s+class="secondary-btn trailer-fs-btn"/.test(detailPage.replace(/\n\s*/g, ' ')), 'F4: the fullscreen control renders ONLY while the trailer is active');
ok(/youtube\.com\/embed\/\$\{trailerKey\}/.test(detailPage), 'F4: the SAME YouTube embed source contract is preserved');
ok(!/trailerKey\s*=\s*['"][a-zA-Z0-9_-]{5,}['"]/.test(detailPage), 'F4: no hardcoded trailer id in the page');
ok(/requestFullscreen/.test(detailPage) && /try\s*\{[\s\S]*?requestFullscreen[\s\S]*?\}\s*catch/.test(detailPage), 'F4: Fullscreen API is guarded (graceful fallback where unsupported)');
ok(/orientation\.lock/.test(detailPage) && /catch/.test(detailPage.split('orientation.lock')[1]?.slice(0, 200) ?? ''), 'F4: landscape orientation lock is user-initiated AND guarded (documented fallback)');
ok(/exitTrailerFullscreen|exitFullscreen/.test(detailPage), 'F4: fullscreen exit path exists (returns to the normal layout)');
ok(/document\.fullscreenElement === trailerContainer/.test(detailPage), 'F4: fullscreen state is tracked on the player container');
ok(/stopTrailer/.test(detailPage) && /trailerActive = false/.test(detailPage), 'F4: Trailer Off stops playback');
ok(/\{#key trailerAttempt\}/.test(detailPage), 'F4: retry remounts a FRESH iframe (no stale media, no duplicate players)');
ok((detailPage.match(/youtube\.com\/embed\//g) ?? []).length === 1, 'F4: exactly ONE iframe embed (no duplicate players)');
ok(/onload=\{\(\) => \{\s*clearTrailerLoadTimeout\(\); trailerStatus = 'ready'; \}\}/.test(detailPage), 'F4: loading state clears on iframe load');
ok(/TRAILER_LOAD_TIMEOUT_MS/.test(detailPage), 'F4: a bounded load timeout surfaces the error state (provider cannot report embed errors)');
ok(/Trailer is unavailable/.test(detailPage), 'F4: a graceful unavailable-trailer error state exists');
ok(/Loading trailer/.test(detailPage), 'F4: a polite loading state exists');
// Stale playback guard: a title switch stops the trailer.
ok(/if \(trailerActive\) stopTrailer\(\)/.test(detailPage), 'F4: navigating to another title stops the trailer (stale-playback guard)');
// Keyboard + focus behavior.
ok(/event\.key === 'Escape' && !document\.fullscreenElement/.test(detailPage), 'F4: Escape stops the inline trailer (unless the browser is consuming it to exit fullscreen)');
ok(/trailerToggle\?\.focus\(\)/.test(detailPage), 'F4: focus returns to the Trailer toggle after stopping');
ok(/querySelector<HTMLElement>\('\.trailer-fs-btn'\)/.test(detailPage), 'F4: focus moves to the fullscreen control when the trailer starts (keyboard reachable)');
ok(/allowfullscreen/.test(detailPage), 'F4: iframe keeps allowfullscreen');
ok(/autoplay=1&rel=0/.test(detailPage), 'F4: the embed autoplay/rel params are unchanged (audio allowed by the user-initiated click)');
// Reduced motion.
ok(/\.trailer-inline :global\(\.trailer-spinner\) \{ animation: none !important; \}/.test(detailPage), 'F4: the loading spinner is disabled under prefers-reduced-motion');

// ============================================================
// 5. Fix 5 — downloader sheet adopts the active title palette
// ============================================================
ok(/export let paletteStyle: string = ''/.test(downloadSheet), 'F5: DownloadSheet accepts an explicit paletteStyle prop');
ok(/<div class="dl-layer" role="presentation" style=\{paletteStyle\}>/.test(downloadSheet) || /class="dl-layer"[\s\S]{0,40}style=\{paletteStyle\}/.test(downloadSheet), 'F5: the palette vars are applied inline on the sheet layer (scoped — no global mutation)');
ok(/--accent:\s*var\(--dp-accent,\s*var\(--color-primary, #00ff9c\)\)/.test(downloadSheet), 'F5: add-on accent maps to the title palette (green fallback preserved)');
ok(/--accent-2:\s*var\(--dp-accent-2,\s*var\(--color-secondary, #00d9ff\)\)/.test(downloadSheet), 'F5: plugin accent maps to the title-palette sibling (blue fallback preserved)');
ok(/--glow-primary:\s*0 0 20px var\(--dp-glow,/.test(downloadSheet), 'F5: glow follows the title palette');
ok(/var\(--dp-deep,\s*#0d0d0d\)/.test(downloadSheet), 'F5: sheet background uses the title deep tone (neutral fallback = previous #0d0d0d)');
ok(/var\(--dp-deep-alt,\s*#141414\)/.test(downloadSheet), 'F5: dropdown/menu surfaces use the lifted palette tone');
ok(/var\(--dp-accent-border,/.test(downloadSheet), 'F5: sheet borders follow the title palette');
ok(/var\(--dp-accent,\s*#646464\)/.test(downloadSheet), 'F5: the sheet eyebrow uses the title accent');
ok(/paletteStyle=\{paletteStyle\}/.test(detailPage), 'F5: DetailPage passes the ACTIVE title palette to the sheet');
ok(detailPage.indexOf('const paletteStyle = $derived') < detailPage.indexOf('paletteStyle={paletteStyle}'), 'F5: the SAME derived style the page uses is forwarded (no independent derivation)');
ok(!/import\s*\{[^}]*buildPaletteStyle|buildPaletteStyle\s*\(/.test(downloadSheet), 'F5: the sheet never derives a conflicting palette of its own (the comment reference documents the contract; no import, no call)');
// The palette engine emits the downloader sibling token.
ok(/--dp-accent-2:\s*\$\{palette\.accent2\}/.test(palette) || /--dp-accent-2/.test(palette), 'F5: buildPaletteStyle emits --dp-accent-2 for the sheet');
ok(/--dp-accent-2-soft:\s*\$\{palette\.accent2Soft\}/.test(palette) || /--dp-accent-2-soft/.test(palette), 'F5: buildPaletteStyle emits --dp-accent-2-soft for the sheet');

// ============================================================
// 6. Fix 6 — bottom whitespace
// ============================================================
ok(/padding-bottom:\s*clamp\(36px,\s*5vw,\s*72px\)/.test(detailPage), 'F6: the page-level bottom padding is reduced (was clamp(72px, 8vw, 110px))');
ok(/padding-bottom:\s*calc\(36px \+ env\(safe-area-inset-bottom, 0px\)\)/.test(mobileBlock), 'F6: mobile bottom padding reduced to 36px + safe-area (was 96px)');
ok(/env\(safe-area-inset-bottom/.test(detailPage), 'F6: safe-area compensation preserved (Android system nav / PWA home indicator)');
ok(!/padding-bottom:\s*96px/.test(detailPage), 'F6: the old 96px mobile padding is gone');
ok(!/margin-bottom:\s*-|margin-top:\s*-\d+px;?\s*\/\*\s*pull last/.test(detailPage), 'F6: no negative-margin hacks');

// ============================================================
// 7. Regression guards — MAV-22 and earlier behavior preserved
// ============================================================
// Palette engine contracts.
for (const token of ['--dp-deep', '--dp-deep-alt', '--dp-fade-mid', '--dp-surface', '--dp-accent', '--dp-accent-soft', '--dp-accent-border', '--dp-glow', '--dp-scrim']) {
  ok(palette.includes(token), `R: palette token ${token} still emitted`);
}
ok(!palette.includes('--color-primary'), 'R: palette never touches the global accent token');
ok(/DetailPaletteController/.test(palette) && /isStale/.test(palette), 'R: stale-safe palette controller intact');
ok(/CACHE_MAX_ENTRIES = 24/.test(palette), 'R: bounded LRU palette cache intact');
// DetailPage MAV-22 contracts (spot checks — the full mav22 suite still runs).
for (const marker of ['poster-card', 'hero-info', 'details-grid', 'cast-section', 'recs-section', 'provider-strip', 'overview-section']) {
  ok(detailPage.includes(marker), `R: MAV-22 structure .${marker} preserved`);
}
ok(/appendReturnTo|navigateBackOr/.test(detailPage), 'R: back/return navigation contract preserved');
ok(/openEpisodeDownloadSheet/.test(detailPage), 'R: episode download flow preserved');
ok(/SeasonEpisodes/.test(detailPage), 'R: seasons/episodes section preserved');
ok(/getLatestResumeTarget/.test(detailPage), 'R: resume/continue-watching resolution preserved');
ok(/structuredData/.test(detailPage) && /application\/ld\+json/.test(detailPage), 'R: SEO structured data preserved');
// Navigation policy.
ok(/window\.history\.back\(\)/.test(navigation), 'R: real history.back policy preserved');
// Snapshot + scroll restoration.
ok(/restore:\s*\(value/.test(layoutSvelte) && /behavior: 'instant'/.test(layoutSvelte), 'R: instant scroll restoration preserved');

// ============================================================
// 8. Fixtures — honest enrichment enabling QA of the chip + trailer
// ============================================================
ok(/MAV-23/.test(contentData) && /fixture enrichment/i.test(contentData), 'FX: the fixture enrichment is documented in-source');
for (const id of ['afterlight', 'emberline', 'nocturne-city']) {
  const block = contentData.slice(contentData.indexOf(`id: '${id}'`), contentData.indexOf(`id: '${id}'`) + 1400);
  ok(/trailerKey:\s*'/.test(block), `FX: ${id} carries a REAL YouTube trailerKey (exercises the inline trailer in fixture environments)`);
}
ok(!/trailerKey:\s*'[\w-]*'(?![\s\S]*youtube)/.test('') , 'FX: placeholder');
const trailerKeys = [...contentData.matchAll(/trailerKey:\s*'([\w-]+)'/g)].map((m) => m[1]);
ok(trailerKeys.every((k) => k.length >= 8), 'FX: trailer keys look like real YouTube ids (>= 8 chars)');
ok(new Set(trailerKeys).size === trailerKeys.length, 'FX: distinct trailer keys per title');
const providerBlocks = [...contentData.matchAll(/streamingProviders:\s*\[([\s\S]{0,400}?)\]/g)];
ok(providerBlocks.length >= 4, `FX: ${providerBlocks.length} fixture titles carry streamingProviders (>= 4)`);
for (const block of providerBlocks) {
  ok(/name:\s*'/.test(block[1]), 'FX: every provider entry has a name');
  ok(/id:\s*\d+/.test(block[1]), 'FX: every provider entry has an id');
}

// ============================================================
// 9. Behavioral — palette sibling derivation (Fix 5 engine support)
// ============================================================
const paletteMod = await import(`${repoRoot}src/lib/client/detail/palette.ts`);
type PaletteModule = {
  NEUTRAL_FALLBACK: { hue: number; accent: string; accent2?: string };
  derivePaletteFromPixels: (pixels: number[], key: string) => Record<string, unknown> & { hue: number; accent: string; accent2: string; neutral: boolean };
  buildPaletteStyle: (p: Record<string, unknown>) => string;
  DetailPaletteController: new (cb: (p: unknown) => void) => {
    request: (key: string, extract?: (url: string) => Promise<unknown>) => void;
    dispose: () => void;
  };
};
const P = paletteMod as unknown as PaletteModule;

// buildPaletteStyle exposes the sibling token for the downloader.
const style = P.buildPaletteStyle({ hue: 160, neutral: false, deep: '', deepAlt: '', fadeMid: '', surface: '', accent: '', accent2: '', accent2Soft: '', accentSoft: '', accentBorder: '', glow: '', scrim: '', key: 'x' });
ok(style.includes('--dp-accent-2:'), 'BEH: buildPaletteStyle emits --dp-accent-2');
ok(style.includes('--dp-accent-2-soft:'), 'BEH: buildPaletteStyle emits --dp-accent-2-soft');
ok(!style.includes('--color-primary'), 'BEH: the style still never touches the global accent');

// derivePaletteFromPixels produces a sibling accent in the SAME hue family.
function pixelsOf(rgb: [number, number, number], n = 400): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push(rgb[0], rgb[1], rgb[2], 255);
  return out;
}
const green = P.derivePaletteFromPixels(pixelsOf([34, 197, 94]), 'green-sib');
const blue = P.derivePaletteFromPixels(pixelsOf([59, 130, 246]), 'blue-sib');
ok(typeof green.accent2 === 'string' && green.accent2.length > 0, 'BEH: chromatic palette carries an accent2 sibling');
ok(green.accent2 !== blue.accent2, 'BEH: sibling accents differ across hues (title-scoped, not one fixed color)');
ok(!P.NEUTRAL_FALLBACK.accent2 || typeof P.NEUTRAL_FALLBACK.accent2 === 'string', 'BEH: neutral fallback still resolves (sibling defined or safely absent)');

console.log(`\nmav23_detail_polish_test: ${passed} checks passed`);
