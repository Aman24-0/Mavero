#!/usr/bin/env node
/**
 * MAVERO — wgt shell patcher (pack-time; runs on the BUILD OUTPUT only).
 *
 * The Tizen widget manager opens the app at <package root>/index.html
 * (config.xml `<content src="index.html"/>`). The built shell needs pack-time
 * fixes that adapter-static cannot produce, because the widget runs from a
 * file:// origin (the production web app is never touched — this script is
 * only ever invoked by .github/workflows/build-wgt.yml):
 *
 * 1. RELATIVE ASSET PATHS. SvelteKit emits ABSOLUTE asset URLs in the
 *    fallback shell (`/_app/…`, `/favicon.ico`, `/manifest.webmanifest`).
 *    On a file:// origin an absolute path resolves against the FILESYSTEM
 *    ROOT, so every CSS/JS reference 404s and the TV shows a blank grey
 *    screen (observed on UA43AUE60AKLXL / Tizen 6.0). `kit.paths.relative`
 *    does not rewrite the FALLBACK shell's links, so this script rewrites
 *    them: every `"/_app/` string and every `href="/` / `src="/` attribute
 *    becomes relative (root-relative references only — `//`
 *    protocol-relative and remote `https://…` URLs are left alone).
 *
 * 2. CLASSIC BOOT (the ES-modules fix — TV-verified). The Tizen web engine
 *    BLOCKS ES module loading from the widget's file:// origin (origin
 *    "null"): static `type="module"` scripts, dynamic `import()` calls and
 *    modulepreload links are all refused. The TV's boot-diagnostics overlay
 *    proved this ON DEVICE (the chunk files exist but are never executed),
 *    and the earlier AVPlay PoC proved plain CLASSIC scripts load fine.
 *    The wgt build therefore ships ONE classic IIFE bundle (app.js — see
 *    vite.config.ts `mavero-wgt-classic-bundle` + svelte.config.js
 *    bundleStrategy 'single'), and this script replaces SvelteKit's module
 *    bootstrap (`import("/_app/env.js")…import("/app.js")…`) with:
 *      - a CLASSIC inline script that installs the very globals the bundle
 *        reads (`window.__sveltekit_<hash> = { base, env }` — the dynamic
 *        public env module is inlined here as data, because the bundle can
 *        never runtime-import `_app/env.js` as an ES module), captures the
 *        SvelteKit mount element exactly like the original bootstrap did
 *        (`document.currentScript.parentElement`), and on DOMContentLoaded
 *        (which fires AFTER deferred classic scripts) calls the bundle's
 *        exported `start()` through the IIFE global `__mavero_wgt_app`;
 *      - `<script src="./app.js" defer></script>` — a plain classic script,
 *        which file:// origins always allow.
 *    It also strips every `modulepreload` link (they reference ES chunks
 *    the engine would refuse and would spam the boot overlay).
 *
 * 3. STYLESHEET LINK. With the single classic bundle (cssCodeSplit off,
 *    see vite.config.ts) all app CSS is emitted as ONE merged asset under
 *    `_app/immutable/assets/*.css`, which NOTHING references automatically
 *    in the fallback shell. This script injects a relative
 *    `<link rel="stylesheet">` for every emitted stylesheet.
 *
 * 4. NO ANALYTICS. The Umami Cloud loader lives in src/app.html (a plain
 *    template shared with production — it cannot carry a compile-time
 *    branch, and touching app.html would break the production build's
 *    byte-identity). On the TV the Umami script is worse than useless:
 *    its ES2020 syntax is a hard SyntaxError on the Tizen 6.0 engine
 *    (seen in the TV overlay) and the widget's null origin would beacon
 *    nothing anyway. This script removes the loader from the packed shell;
 *    build-wgt.yml asserts `cloud.umami.is` never survives.
 *
 * 5. ON-SCREEN BOOT DIAGNOSTICS. A retail Samsung TV has NO devtools, no
 *    sdb, no console — a failed boot is a blank grey screen with zero
 *    information. A plain (classic, non-module) inline script at the very
 *    top of <head> installs:
 *      - a "Mavero booting…" banner painted immediately (distinguishes
 *        "nothing executed at all" from "CSS loaded but JS failed");
 *      - a full-screen error overlay fed by `window.onerror`-style events
 *        (message + source + stack), `unhandledrejection`, and
 *        capture-phase resource load errors (<script>/<link>/<img>);
 *      - auto-hide of the banner the moment the SPA renders any element
 *        (MutationObserver — the static shell markup parsed at startup
 *        does NOT count), so a working app never stays behind it;
 *        late resource-load noise (e.g. analytics) is ignored once the
 *        app is running so a booted app is never covered;
 *      - Back/Escape dismissal of the overlay after the app has booted.
 *    Whatever fails on the TV, the failure text becomes readable on the
 *    screen itself.
 *
 * 6. BUILT-IN API POLYFILL (the Object.hasOwn fix — TV-verified). esbuild
 *    downlevels SYNTAX for build.target 'es2019' but does NOT polyfill
 *    BUILT-INS: the TV overlay logged
 *      "Uncaught TypeError: Object.hasOwn is not a function (file:///app.js)"
 *    followed by the cascade "classic bundle did not expose
 *    __mavero_wgt_app.start()" (the IIFE died at module evaluation, so the
 *    global was never assigned). This script copies the classic ES5-safe
 *    scripts/wgt_polyfill.js (Object.hasOwn, Object.fromEntries,
 *    String.prototype.replaceAll, WeakRef, FinalizationRegistry, globalThis,
 *    queueMicrotask, Array/String .at(), findLast/findLastIndex,
 *    Promise.allSettled/any + AggregateError, flat/flatMap, structuredClone —
 *    every shim guarded) into the widget root as polyfill.js and loads it
 *    with a CLASSIC SYNC <script src="./polyfill.js"> immediately BEFORE the
 *    <script src="./app.js" defer> boot tag, so every global exists before
 *    the bundle evaluates.
 *
 * 7. TV MODE — STAGE 4 layout layer (widget-build-only CSS + the body
 *    class that activates it). The production web look must stay
 *    untouched, so ALL TV styling lives here, injected as a single
 *    <style id="mavero-tv-mode"> into the packed shell only:
 *      - `body.tv-mode { zoom: 1.2 }` — the couch-distance scale layer
 *        (the 1920px viewport becomes a 1600px layout; every visual pixel
 *        grows 1.2x). zoom is supported by every Blink engine; media
 *        queries still evaluate against the real viewport.
 *      - POSTER GEOMETRY: the Stage-4 TV feedback reported cards "stretched
 *        vertically". The app's poster box relies on CSS `aspect-ratio`,
 *        which the TV engine (Chromium < 88) may not implement — this
 *        stylesheet REASSERTS aspect-ratio AND adds the engine-proof
 *        padding-top:150% ::before fallback (150% = 3/2 = the 2:3 poster
 *        box) plus FIXED TV card widths (200px) on rails, so card height
 *        ALWAYS derives from the poster aspect and never stretches.
 *      - FOCUS VISIBILITY: a `.tv-focused` ring + plain :focus outlines
 *        (the TV's programmatic focus() does not reliably match
 *        :focus-visible and :has() does not exist on this engine — the
 *        SpatialFocusManager adds the class, and :focus-within elevates
 *        the whole poster card, transform-only per the Stage-4 perf rule).
 *      - SIDEBAR / TYPE SCALE: bigger sidebar icons, labels and card
 *        titles for the 3m viewing distance; a hero cap so the rails stay
 *        visible at 1080p; ~5% TV-safe gutter (--d-gutter).
 *      - NO backdrop-filter anywhere on the TV (GPU cost — Stage-4 perf).
 *    The body class is added by a tiny classic script inside the body
 *    wrapper (runs before the bundle boots — no relayout flash, and TV
 *    mode survives even if the bundle later fails).
 *
 * Usage: node scripts/wgt_patch_shell.mjs <path-to-built-index.html>
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
if (!target) {
  console.error('wgt_patch_shell: ERROR — usage: node scripts/wgt_patch_shell.mjs <index.html>');
  process.exit(1);
}

const shellDir = path.dirname(path.resolve(target));
let html = readFileSync(target, 'utf8');
if (!html.includes('<head>')) {
  console.error('wgt_patch_shell: ERROR — <head> not found in the built shell');
  process.exit(1);
}

// §6 — the built-in-API polyfill is copied BEFORE the idempotency guard so a
// re-run over an already-patched shell still guarantees the file exists at the
// widget root (copyFileSync is overwrite-idempotent).
const polyfillSourcePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'wgt_polyfill.js'
);
const polyfillTargetPath = path.join(shellDir, 'polyfill.js');
const polyfillSource = readFileSync(polyfillSourcePath, 'utf8');
copyFileSync(polyfillSourcePath, polyfillTargetPath);
const polyfillWrittenBytes = statSync(polyfillTargetPath).size;

if (html.includes('mavero-wgt-boot-overlay')) {
  console.log('wgt_patch_shell: already patched — polyfill.js ensured, nothing else to do');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. NO ANALYTICS — remove the Umami Cloud loader (see header §4).
// ---------------------------------------------------------------------------

let umamiRemoved = 0;
html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (block) => {
  if (block.includes('cloud.umami.is')) {
    umamiRemoved += 1;
    return '';
  }
  return block;
});

// ---------------------------------------------------------------------------
// §7 — TV MODE: the Stage-4 layout layer. Injected ONLY into the packed
// widget shell (this script never touches the production web build). Every
// selector is scoped under body.tv-mode so even a leaked copy of this text
// could not restyle the web app. (Defined early — the body-class script is
// prepended to the classic boot replacement in §2 below.)
// ---------------------------------------------------------------------------

const tvModeCss = [
  '/* mavero-tv-mode: Stage-4 TV layout layer (wgt build only — see the §7 header) */',
  'body.tv-mode {',
  '  zoom: 1.2;',
  '  --d-gutter: 56px;',
  '}',
  '/* --- Poster geometry: engine-proof 2:3 (aspect-ratio is missing on the',
  '   TV-era Chromium < 88 — the padding-top fallback yields the SAME result',
  '   on engines without it and matches it exactly on engines with it) --- */',
  'body.tv-mode .mc-poster { aspect-ratio: 2 / 3; }',
  "body.tv-mode .mc-poster::before { content: ''; display: block; width: 100%; padding-top: 150%; }",
  'body.tv-mode .skeleton-poster { aspect-ratio: 2 / 3; }',
  "body.tv-mode .skeleton-poster::before { content: ''; display: block; width: 100%; padding-top: 150%; }",
  '/* --- Fixed TV card widths (height derives from the poster aspect) --- */',
  'body.tv-mode .rail { grid-auto-columns: 200px; gap: 16px; }',
  'body.tv-mode .rail.compact { grid-auto-columns: 172px; }',
  "/* --- Focus visibility: the spatial manager adds .tv-focused (the TV's",
  '   programmatic focus() is not reliably :focus-visible; this engine has',
  '   no :has()) — plain :focus outlines + :focus-within card elevation --- */',
  'body.tv-mode a:focus,',
  'body.tv-mode button:focus,',
  'body.tv-mode input:focus,',
  'body.tv-mode select:focus,',
  'body.tv-mode textarea:focus,',
  'body.tv-mode [tabindex="0"]:focus,',
  'body.tv-mode .tv-focused {',
  '  outline: 3px solid rgba(255, 255, 255, .95);',
  '  outline-offset: 3px;',
  '  border-radius: 6px;',
  '}',
  'body.tv-mode .mc-poster:focus-within {',
  '  transform: translateY(-3px) scale(1.05);',
  '  outline: 4px solid #ffffff;',
  '  outline-offset: 2px;',
  '  border-color: var(--color-primary-border, #ffffff);',
  '  box-shadow: 0 0 0 2px rgba(255, 255, 255, .9), 0 18px 36px rgba(0, 0, 0, .55);',
  '  z-index: 2;',
  '}',
  'body.tv-mode .mc-poster:focus-within .mc-play { opacity: 1; transform: scale(1.06); }',
  '/* The card link fills the poster box — its own outline would double the',
  '   poster-level ring; the poster ring is THE card focus indicator. */',
  'body.tv-mode .mc-poster a:focus { outline: none; }',
  '/* --- Sidebar scale (couch distance) --- */',
  'body.tv-mode .app-sidebar { padding-left: 20px; }',
  'body.tv-mode .sidebar-link { min-height: 54px; padding: 10px 14px; }',
  'body.tv-mode .sidebar-link .sidebar-icon svg,',
  'body.tv-mode .sidebar-account .sidebar-icon svg { width: 26px; height: 26px; }',
  'body.tv-mode .sidebar-label { font-size: 1.02rem; font-weight: 700; }',
  'body.tv-mode .brand-word { font-size: 1.3rem; }',
  '/* --- Card text scale --- */',
  'body.tv-mode .mc-title { font-size: .95rem; }',
  'body.tv-mode .mc-meta { font-size: .8rem; }',
  'body.tv-mode .mc-type { font-size: .6rem; padding: 3px 8px; }',
  'body.tv-mode .mc-rating { font-size: .64rem; padding: 3px 8px; }',
  'body.tv-mode .mc-episode-badge { font-size: .66rem; }',
  '/* --- Hero: cap so the rails stay visible on 1080p; larger CTA targets --- */',
  '/* ENGINE-PROOF (pass 3): min() does not parse on this engine (Chromium < 79) —',
  '   an invalid min-height DROPPED the whole declaration and the hero collapsed to',
  '   its text content (~20-25% of the viewport — the reported bug 4). Explicit',
  '   px floor + vh target: the second declaration wins where vh works, the first',
  '   is the floor everywhere. --- */',
  'body.tv-mode .hero-slide, body.tv-mode .hero-content { min-height: 300px; min-height: 36vh; }',
  'body.tv-mode .hero-play, body.tv-mode .hero-btn { min-height: 52px; font-size: .95rem; }',
  'body.tv-mode .hero-copy p { font-size: .95rem; }',
  'body.tv-mode .hero-meta { font-size: .9rem; }',
  'body.tv-mode .section-title { font-size: 1.5rem; }',
  'body.tv-mode .section-link { font-size: .88rem; }',
  '/* --- Boot skeleton (the tvBooting state; plain divs — see DiscoverPage) --- */',
  'body.tv-mode .tv-boot-skeleton { padding: 24px var(--d-gutter, 56px) 40px; }',
  'body.tv-mode .tv-boot-skel-rail { margin-top: 34px; }',
  'body.tv-mode .tv-boot-skel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }',
  'body.tv-mode .tv-boot-skel-title { display: block; width: 180px; height: 18px; border-radius: 6px; background: var(--surface-2, #10161b); }',
  'body.tv-mode .tv-boot-skel-link { display: block; width: 72px; height: 12px; border-radius: 6px; background: var(--surface-2, #10161b); }',
  'body.tv-mode .tv-boot-skel-row { display: grid; grid-auto-flow: column; grid-auto-columns: 200px; gap: 16px; overflow: hidden; }',
  'body.tv-mode .tv-boot-skel-card { display: block; width: 100%; height: 300px; border-radius: var(--radius-md, 8px); background: var(--surface-2, #10161b); }',
  '',
  '/* ================= TV-UX pass (focus + layout corrections) =================',
  '   The on-device pass reported: rails that never slid (focus vanished at',
  '   the row end), hero/detail backdrops missing, uneven rail rows, sidebar',
  '   permanently expanded and an unreadable search input. The focus manager',
  '   ($lib/tv/focus) owns the behaviour; this layer owns the geometry.',
  '   ========================================================================== */',
  '',
  '/* --- Rail slide model (Samsung rule 5): content moves ONLY at a row edge,',
  '   via a CSS transform applied by the focus manager. Native rail scrolling',
  '   is DISABLED (the TV engine silently drops scrollIntoView — the reported',
  '   "focus disappears at the rail end") and the desktop arrows go away: the',
  '   D-pad IS the scroll affordance. will-change is deliberately ABSENT: the',
  '   composited-layer hint + body zoom broke poster rasterisation on the TV',
  '   engine (the reported blank poster areas in every rail). --- */',
  'body.tv-mode .rail { overflow-x: hidden; transition: transform 240ms ease; }',
  'body.tv-mode .rail-nav { display: none; }',
  '/* --- Poster image geometry: the base CSS positions the poster <img>',
  '   with the `inset` shorthand (Chromium 87+). Explicit offsets are the',
  '   engine-proof equivalent — identical on engines that support inset,',
  '   the ONLY working form on engines that do not. Without them the img',
  '   falls to its static position BELOW the aspect spacer and the poster',
  '   box (overflow: hidden) clips it away entirely. --- */',
  'body.tv-mode .mc-poster img { top: 0; left: 0; right: 0; bottom: 0; }',
  'body.tv-mode .mc-poster .mc-fallback { top: 0; left: 0; right: 0; bottom: 0; }',
  'body.tv-mode .progress-ring { top: 0; left: 0; right: 0; bottom: 0; }',
  '/* THE CARD FOCUS UNIT FILLS THE POSTER BOX. The ::before aspect spacer',
  '   above is an IN-FLOW box, so the in-flow .mc-card-link rendered BELOW',
  '   it — its rect (the spatial model, the focus ring and the tap target)',
  '   sat ~360px under the visible poster ("poster at the bottom with empty',
  '   space above", rings below the art, vertical walks skipping rows).',
  '   Making the link absolute pins it over the artwork: rect == poster box.',
  '   The selection-mode button is already absolute; badges are absolute. */',
  'body.tv-mode .mc-poster .mc-card-link { position: absolute; top: 0; left: 0; right: 0; bottom: 0; height: auto; }',
  'body.tv-mode .mc-poster .mc-select { top: 0; left: 0; right: 0; bottom: 0; }',
  '/* --- Exact 2:3 rail rows: explicit poster heights derived from the FIXED',
  '   card widths (200px/172px × 1.5) — no reliance on aspect-ratio (missing',
  '   on this engine) and no dead space above/below the poster: every rail',
  '   row is poster + compact title block, aligned to the top. --- */',
  'body.tv-mode .rail { grid-auto-rows: min-content; align-items: start; }',
  'body.tv-mode .rail .mc-poster { height: 300px; }',
  'body.tv-mode .rail.compact .mc-poster { height: 258px; }',
  'body.tv-mode .rail .mc-info { min-height: 46px; }',
  '/* The hover-only Details link is unreachable on a remote — the card',
  '   itself opens the detail page (Enter). Removing it keeps the row height',
  '   uniform (no hidden absolute element shifting the tallest card). */',
  'body.tv-mode .rail .mc-detail { display: none; }',
  '/* --- Trailing SHOW MORE (ContentRail tvLoadMore; the row-end focus stop',
  '   that loads more items and hands focus into the new cards) --- */',
  'body.tv-mode .rail-tv-more-cell { display: block; }',
  'body.tv-mode .rail-tv-more {',
  '  display: grid; place-items: center;',
  '  width: 100%; height: 300px; padding: 0 10px;',
  '  border: 2px dashed var(--color-border-strong, #2c3a44); border-radius: var(--radius-md, 8px);',
  '  color: var(--color-text-muted, #9fb2bd); background: rgba(16, 22, 27, .6);',
  '  font: inherit; font-size: .92rem; font-weight: 800; letter-spacing: .04em; text-transform: uppercase;',
  '  cursor: pointer;',
  '}',
  'body.tv-mode .rail.compact .rail-tv-more { height: 258px; font-size: .8rem; }',
  'body.tv-mode .rail-tv-more.tv-loading { opacity: .7; }',
  '',
  '/* --- Hero: ~36% of the 1080p screen (bug 4: the top 30-40% band),',
  '   full-bleed backdrop, bottom-left copy (the premium feel). ENGINE-PROOF:',
  '   min()/clamp() are Chromium 79+ and this engine is 69-76 — the old',
  '   min(60vh, 620px)/clamp() rules were DROPPED wholesale (invalid',
  '   declarations never apply), collapsing the hero to its text and its',
  '   headline to the browser default. Explicit vh/px values parse',
  '   everywhere. --- */',
  'body.tv-mode .hero-slide,',
  'body.tv-mode .hero-content,',
  'body.tv-mode .spotlight-slide { min-height: 300px; min-height: 36vh; }',
  'body.tv-mode .hero-copy h1 { font-size: 46px; }',
  'body.tv-mode .hero-copy p { font-size: 1rem; max-width: 620px; }',
  'body.tv-mode .hero-meta { font-size: .95rem; }',
  'body.tv-mode .slide-title { font-size: 46px; }',
  'body.tv-mode .slide-desc { font-size: .95rem; max-width: 560px; }',
  '/* The hero copy padding rides on clamp(--d-gutter) in the shared CSS — an',
  '   invalid clamp DROPS the whole shorthand, so the copy hugged the screen',
  '   edges (the "artwork misaligned" half of bug 4). Explicit gutter box. --- */',
  'body.tv-mode .hero-content, body.tv-mode .slide-content { padding: 40px 56px 56px; }',
  'body.tv-mode .hero-play, body.tv-mode .hero-btn, body.tv-mode .slide-play, body.tv-mode .slide-more { min-height: 54px; font-size: 1rem; }',
  'body.tv-mode .hero-nav-btn, body.tv-mode .spotlight-nav-btn { width: 44px; height: 44px; }',
  'body.tv-mode .hero-dot::after, body.tv-mode .spotlight-dot::after { width: 8px; height: 8px; }',
  'body.tv-mode .hero-dot.active::after, body.tv-mode .spotlight-dot.active::after { width: 22px; }',
  '',
  '/* --- Hero/spotlight ARTWORK LAYERS (bug 2 + the CSS half of bug 6): the',
  '   shared CSS positions every absolutely-placed hero layer with the',
  '   `inset` shorthand (Chromium 87+ — MISSING here). An invalid inset',
  '   drops the offsets and an absolutely-positioned box with auto offsets',
  '   collapses to zero at its static position: .hero-media/.slide-media',
  '   (and their 100% img) painted NOTHING — the Discover/spotlight hero',
  '   backdrop bug. Explicit top/right/bottom/left are the engine-proof',
  '   equivalent (identical where inset works). The same fix covers the',
  '   scrims, the accent fallback panel and the DETAIL page hero.',
  '   (The fetched TV detail item carries the w1280 backdrop — see',
  '   DetailPage.downgradeTvHeroArtwork — so .hero-img paints fast.) --- */',
  'body.tv-mode .hero-media,',
  'body.tv-mode .hero-scrim,',
  'body.tv-mode .hero-image-fallback { top: 0; right: 0; bottom: 0; left: 0; }',
  'body.tv-mode .hero-image { top: 0; right: 0; bottom: 0; left: 0; width: 100%; height: 100%; }',
  'body.tv-mode .slide-media,',
  'body.tv-mode .slide-scrim { top: 0; right: 0; bottom: 0; left: 0; }',
  'body.tv-mode .slide-media img { top: 0; right: 0; bottom: 0; left: 0; width: 100%; height: 100%; }',
  '',
  '/* --- Detail page: BACKDROP hero (the reported "poster fills the screen"),',
  '   poster compact beside the metadata, recommendations at main-rail size.',
  '   .hero-img/.palette-canvas carry the same inset collapse as the',
  '   carousel heroes above — explicit offsets restore the backdrop AND the',
  '   artwork-derived page gradient. --- */',
  'body.tv-mode .detail-page .hero { min-height: 380px; min-height: 44vh; }',
  'body.tv-mode .detail-page .hero-img,',
  'body.tv-mode .detail-page .hero-scrim,',
  'body.tv-mode .detail-page .palette-canvas { top: 0; right: 0; bottom: 0; left: 0; }',
  'body.tv-mode .hero-grid { grid-template-columns: 200px minmax(0, 1fr); column-gap: 22px; }',
  'body.tv-mode .poster-card { height: 300px; }',
  'body.tv-mode .detail-title { font-size: 40px; }',
  'body.tv-mode .meta-row { font-size: .95rem; }',
  'body.tv-mode .play-btn { min-height: 56px; font-size: 1rem; }',
  'body.tv-mode .secondary-btn { min-height: 48px; font-size: .92rem; }',
  'body.tv-mode .genre-chip { font-size: .82rem; padding: 5px 12px; }',
  'body.tv-mode .recs-row { grid-auto-columns: 200px; gap: 16px; }',
  'body.tv-mode .rec-poster { height: 300px; }',
  'body.tv-mode .section-h { font-size: 1.4rem; }',
  '',
  '/* --- Trailer MODAL SHEET (bug 7): the sheet EXISTS since pass 2 but its',
  '   frame rode on width: min(88vw, 1180px) / height: min(62vh, 600px) —',
  '   both DROPPED on this engine, leaving a zero-size frame: the reported',
  '   "pressing Trailer only toggles the button — no trailer appears".',
  '   Explicit ~70%-of-screen frame with ancient-property guards',
  '   (max-width/max-height parse everywhere). --- */',
  'body.tv-mode .trailer-sheet-frame { width: 1180px; height: 660px; max-width: 92vw; max-height: 70vh; }',
  'body.tv-mode .trailer-sheet-close { min-height: 52px; font-size: 1rem; }',
  '',
  '/* --- Explorer pages (Movies / TV Shows / Anime): main-rail-size grid,',
  '   readable chips, TV-safe margins --- */',
  'body.tv-mode .explorer-grid { grid-template-columns: repeat(auto-fill, 200px); gap: 26px 16px; }',
  'body.tv-mode .explorer-grid .mc-poster { height: 300px; }',
  'body.tv-mode .explorer-results, body.tv-mode .explorer-sections { width: auto; max-width: none; margin-inline: var(--d-gutter, 56px); }',
  'body.tv-mode .filter-chip { min-height: 46px; padding: 8px 18px; font-size: .92rem; }',
  'body.tv-mode .results-title { font-size: 1.5rem; }',
  '',
  '/* --- Search: the TV engine paints its own WHITE input background (the',
  '   reported invisible text) unless the colours are forced explicitly --- */',
  'body.tv-mode .search-field { background: #10161b; }',
  'body.tv-mode .search-field input {',
  '  background: #10161b;',
  '  color: #f2fff8;',
  '  -webkit-appearance: none;',
  '  appearance: none;',
  '  caret-color: #f2fff8;',
  '}',
  'body.tv-mode .search-field input::placeholder { color: #5d7280; }',
  'body.tv-mode .search-field { min-height: 64px; }',
  'body.tv-mode .type-seg { min-height: 46px; padding: 8px 20px; font-size: .92rem; }',
  '',
  '/* --- Search results sized EXACTLY like the main rails (bug 8: search',
  '   cards rendered taller than the rails with dead space around the',
  '   poster). The same fixed 200px column + 300px 2:3 poster + compact',
  '   title block as the rails/explorer grid — equal-height rows, no dead',
  '   space. --- */',
  'body.tv-mode .results-grid { grid-template-columns: repeat(auto-fill, 200px); gap: 26px 16px; justify-content: start; }',
  'body.tv-mode .results-grid .mc-poster { height: 300px; }',
  'body.tv-mode .results-grid .mc-info { min-height: 46px; }',
  '',
  '/* --- Scroll-to-top: ONE combined control (ring around the button),',
  '   bottom-RIGHT of the content area (bug 6). Explicit px geometry + all',
  '   four offsets so no engine shorthand/env()-parse quirk can detach the',
  '   ring from the button or re-anchor the FAB. --- */',
  'body.tv-mode .scroll-to-top {',
  '  right: 44px !important;',
  '  bottom: 44px !important;',
  '  left: auto !important;',
  '  top: auto !important;',
  '  width: 56px !important;',
  '  height: 56px !important;',
  '}',
  'body.tv-mode .scroll-to-top .progress-ring { top: 0 !important; left: 0 !important; width: 100% !important; height: 100% !important; }',
  '',
  '/* --- Sidebar: collapsed icon rail by default (the manager auto-expands',
  '   on focus entry and auto-collapses back); bigger touch targets. The',
  '   expand/collapse is DETERMINISTIC (bug 5): no width transition (a',
  '   transition racing the focus moves reads as the sidebar hiding on its',
  '   own), ONE solid panel background for the full height/width, and an',
  '   explicit screen height (the base 100dvh does not parse on this engine',
  '   — top:0/bottom:0 stretched it, but the zoom-corrected height keeps',
  '   the whole panel on the physical screen).',
  '   PASS 3 (bug 5): the width is var(--sidebar-current) — the variable',
  '   AppShell rewrites on every expand/collapse event. The old pinned',
  '   var(--sidebar-collapsed) kept the PANEL at the collapsed width while the',
  '   labels overflowed it (the "grey panel only covers the collapsed',
  '   width even when expanded" report) — now the panel follows the state:',
  '   76px icon rail ↔ the full expanded width, one solid grey surface.',
  '   The rail also gains a small margin from the screen edge and a rounded',
  '   right profile; .app-main clears panel + margin so no content hides',
  '   under the expanded panel. --- */',
  'body.tv-mode .app-sidebar {',
  '  left: 10px;',
  '  width: var(--sidebar-current, var(--sidebar-collapsed, 76px));',
  '  height: calc(100vh / 1.2);',
  '  background: #12181d;',
  '  border-radius: 0 14px 14px 0;',
  '  transition: none;',
  '}',
  'body.tv-mode .app-main { margin-left: calc(var(--sidebar-current, var(--sidebar-collapsed, 76px)) + 10px); }',
  'body.tv-mode .sidebar-link, body.tv-mode .sidebar-account { min-height: 56px; }',
  'body.tv-mode .sidebar-link .sidebar-icon svg,',
  'body.tv-mode .sidebar-account .sidebar-icon svg { width: 28px; height: 28px; }',
  'body.tv-mode .sidebar-toggle { width: 40px; height: 40px; }',
  '',
  '/* --- Focus ring: THICK high-contrast (Samsung rule 4) --- */',
  'body.tv-mode a:focus,',
  'body.tv-mode button:focus,',
  'body.tv-mode input:focus,',
  'body.tv-mode select:focus,',
  'body.tv-mode textarea:focus,',
  'body.tv-mode .tv-focused {',
  '  outline: 4px solid #ffffff;',
  '  outline-offset: 4px;',
  '  border-radius: 6px;',
  '}',
  '/* TV watch standby card (the Play-crash fix\u0027s loading/failed state) */',
  'body.tv-mode .tv-watch-standby { min-height: 70vh; font-size: 1.15rem; }',
  '',
  '/* --- TV performance: no backdrop blur on the TV GPU (Stage-4 note) --- */',
  'body.tv-mode * { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }',

  '',
  '/* ================= TV-UX pass 4 (on-device test pass 4) ================= */',
  '',
  '/* --- Bug 2: the hero nav cluster (dots + prev/next arrows) must sit at',
  '   the HERO\u0027S BOTTOM-RIGHT. The base rules anchor it with',
  '   right: clamp(...) — clamp() DROPS on this engine (Chromium < 79), the',
  '   anchor is lost and the cluster falls to its STATIC position at the',
  '   LEFT edge under the Play/Details buttons (the reported placement).',
  '   Explicit px anchors restore the bottom-right slot (identical where',
  '   clamp parses). --- */',
  'body.tv-mode .hero-nav,',
  'body.tv-mode .spotlight-nav { right: 40px; bottom: 24px; left: auto; top: auto; }',
  '/* --- Bug 2 (focus order): with the cluster restored to the bottom-right,',
  '   the focus manager keeps Left/Right INSIDE each hero row; the cluster is',
  '   reachable only via Down (action row -> cluster -> first rail head). --- */',
  '',
  '/* --- Bug 8: the rail heading and the Movie/TV Shows/Anime chips beside',
  '   it read as touching at couch distance — comfortable gaps (plain px,',
  '   engine-proof). .results-heading gets the same treatment for the',
  '   Explorer filtered-results head. --- */',
  'body.tv-mode .section-head { gap: 20px; }',
  'body.tv-mode .section-head-left { gap: 18px; }',
  'body.tv-mode .section-head-right { gap: 12px; }',
  'body.tv-mode .type-chips { gap: 8px; }',
  'body.tv-mode .results-heading { gap: 20px; }',
  '',
  '/* --- Bug 3: the DETAIL hero backdrop. Two engine-proof layers:',
  '   (a) the hero gets an EXPLICIT height (not only min-height) so the',
  '   absolutely-positioned 100%-height img always resolves against a',
  '   definite box; (b) the artwork-derived palette cross-fade layer is',
  '   DISPLAY-NONE — it is an opaque full-page gradient stacked via z-index,',
  '   the prime "image painted but blank behind an opaque layer" suspect on',
  '   this engine, and hiding it costs nothing (the page\u0027s own background',
  '   gradient below stays; the --dp-* accent tokens keep applying via the',
  '   inline palette style). --- */',
  'body.tv-mode .detail-page .hero { height: 380px; height: 44vh; min-height: 380px; }',
  'body.tv-mode .detail-page .palette-canvas { display: none; }',
  '',
  '/* --- Bug 4: the trailer MODAL SHEET is a ~70%-of-screen centered PANEL.',
  '   The component CSS centers it with left/top 50% + translate(-50%,-50%)',
  '   (all parse on this engine); the TV layer additionally PINS the exact',
  '   70% frame with explicit offsets — 70% of the 1600x900 zoomed layout',
  '   viewport = 1120x630 CSS px at left 240 / top 135 (zoom scales the',
  '   offset and the size consistently, so the panel stays centered under',
  '   either zoom interpretation and can never fall off-screen). The frame',
  '   fills the panel below the CLOSE chrome row (flex 1). --- */',
  'body.tv-mode .trailer-sheet { left: 240px; top: 135px; right: auto; bottom: auto; transform: none; width: 1120px; height: 630px; max-width: 92vw; max-height: 82vh; }',
  'body.tv-mode .trailer-sheet-frame { flex: 1 1 auto; min-height: 0; width: 100%; }',
  'body.tv-mode .trailer-sheet-close { min-height: 52px; font-size: 1rem; }',
  '',
  '/* --- Bug 1: the DiscoverSection/Adult endcap "Show more" card gets the',
  '   same full-height dashed TV card as ContentRail\u0027s .rail-tv-more —',
  '   align-items:start on the tv-mode rail would otherwise shrink it to a',
  '   content-height stub at the row\u0027s end. --- */',
  'body.tv-mode .rail-endcap { display: block; min-width: 0; }',
  'body.tv-mode .show-more-card {',
  '  display: grid; place-items: center;',
  '  width: 100%; height: 300px; padding: 0 10px;',
  '  border: 2px dashed var(--color-border-strong, #2c3a44); border-radius: var(--radius-md, 8px);',
  '  color: var(--color-text-muted, #9fb2bd); background: rgba(16, 22, 27, .6);',
  '  font: inherit; font-size: .92rem; font-weight: 800; letter-spacing: .04em; text-transform: uppercase;',
  '  cursor: pointer;',
  '}',
  '',
  '/* --- Bug 5: the sidebar panel gains a 6px gap to the main content area',
  '   (the panel currently touches it: margin-left == panel width + the',
  '   panel\u0027s own 10px screen offset — zero visual gap). The inner spacing',
  '   tightens slightly (nav top margin 22->14, bottom block gap 14->10). --- */',
  'body.tv-mode .app-main { margin-left: calc(var(--sidebar-current, var(--sidebar-collapsed, 76px)) + 16px); }',
  'body.tv-mode .sidebar-nav { margin-top: 14px; }',
  'body.tv-mode .sidebar-bottom { gap: 10px; }',
  ''
].join('\n');

// The body class is added the moment the parser reaches the body wrapper —
// before the bundle evaluates and before the first paint of app content
// (the boot banner is the only thing visible then, so no relayout flash).
// Plain ES2017, same discipline as the other shell scripts.
const tvModeClassScript =
  '<script>/* mavero-wgt-tv-mode: activate the Stage-4 TV layout layer (see §7) */\n' +
  'try { document.body.className += (document.body.className ? " " : "") + "tv-mode"; } catch (e) {}</script>';

const tvModeStyleTag = `<style id="mavero-tv-mode">\n${tvModeCss}\n</style>`;

// ---------------------------------------------------------------------------
// 2. CLASSIC BOOT — replace SvelteKit's module bootstrap (see header §2).
// ---------------------------------------------------------------------------

// Locate the module bootstrap: the (only) inline <script> that wires up the
// kit payload global and dynamically imports the entry modules.
const scriptBlocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
const bootstrapBlock = scriptBlocks.find((m) => /__sveltekit_[A-Za-z0-9]+\s*=/.test(m[1]));
if (!bootstrapBlock) {
  console.error(
    'wgt_patch_shell: ERROR — SvelteKit module bootstrap not found ' +
      '(no inline <script> containing the __sveltekit_<hash> payload global)'
  );
  process.exit(1);
}

const hashMatch = bootstrapBlock[1].match(/__sveltekit_([A-Za-z0-9]+)\s*=/);
if (!hashMatch) {
  console.error('wgt_patch_shell: ERROR — could not extract the __sveltekit_<hash> global name');
  process.exit(1);
}
const kitHash = hashMatch[1];

// Inline the dynamic public env as DATA. The bundle reads
// `__sveltekit_<hash>.env` — the original bootstrap filled it from a runtime
// ES-module import of _app/env.js, which file:// forbids. The generated
// env module is one line: `export const env={PUBLIC_…:"…",…}` — convert it
// to an object literal and embed it in the classic boot script.
const envJsPath = path.join(shellDir, '_app', 'env.js');
let envLiteral = '{}';
if (existsSync(envJsPath)) {
  const envSrc = readFileSync(envJsPath, 'utf8');
  const envMatch = envSrc.match(/export\s+const\s+env\s*=\s*(\{[\s\S]*\})/);
  if (!envMatch) {
    console.error(
      'wgt_patch_shell: ERROR — could not parse the generated env module ' +
        `(${path.relative(shellDir, envJsPath)}). Expected "export const env={…}".`
    );
    process.exit(1);
  }
  envLiteral = envMatch[1];
} else {
  console.log('wgt_patch_shell: note — no generated _app/env.js (no dynamic public env); env = {}');
}

// The classic boot script: plain ES2017-style code (no arrow functions,
// no optional chaining, no template literals — same discipline as the
// overlay script below), positioned EXACTLY where SvelteKit's bootstrap
// was (inside the %sveltekit.body% wrapper div) so the mount element is
// identical, and booting the IIFE bundle after the deferred classic
// script has executed (DOMContentLoaded always fires after defer).
const classicBootScript =
  `<script>/* mavero-wgt-classic-boot: ES modules are blocked on the widget's file:// origin ` +
  `(Tizen 6.0, origin "null" — TV-verified). This classic script installs the globals the ` +
  `bundle reads (window.__sveltekit_${kitHash} = { base, env } — the dynamic public env is ` +
  `inlined as data), captures the SvelteKit mount element exactly like the original module ` +
  `bootstrap did, and boots the single classic IIFE bundle (./app.js) after it has loaded. */\n` +
  `(function () {\n` +
  `  try {\n` +
  `    var g = window;\n` +
  `    g.__sveltekit_${kitHash} = {\n` +
  `      base: new URL('.', location).pathname.slice(0, -1),\n` +
  `      env: ${envLiteral}\n` +
  `    };\n` +
  `    g.__mavero_wgt_mount = document.currentScript ? document.currentScript.parentElement : null;\n` +
  `    g.addEventListener('DOMContentLoaded', function () {\n` +
  `      try {\n` +
  `        var app = g.__mavero_wgt_app;\n` +
  `        if (!app || typeof app.start !== 'function') {\n` +
  `          throw new Error('classic bundle did not expose __mavero_wgt_app.start()');\n` +
  `        }\n` +
  `        app.start(g.__mavero_wgt_mount);\n` +
  `      } catch (e) {\n` +
  `        setTimeout(function () { throw e; }, 0); /* surface on window.onerror (boot overlay) */\n` +
  `      }\n` +
  `    });\n` +
  `  } catch (e) {\n` +
  `    setTimeout(function () { throw e; }, 0);\n` +
  `  }\n` +
  `})();\n` +
  `</script>\n` +
  // §6 — the polyfill is a CLASSIC SYNCHRONOUS script loaded BEFORE the
  // deferred bundle: sync scripts execute in document order during parsing,
  // and a deferred script executes only AFTER the document has been parsed,
  // so every polyfilled global exists before app.js module-evaluates (the TV
  // crash happened exactly at that point).
  `<script src="./polyfill.js"></script>\n` +
  `<script src="./app.js" defer></script>`;

html = html.replace(bootstrapBlock[0], `${tvModeClassScript}\n${classicBootScript}`);

// Strip every modulepreload link — they preload ES chunks that the file://
// engine refuses (the TV overlay logged exactly this as "failed to load
// link") and would only add boot-overlay noise.
const modulePreloadCount = (html.match(/<link\b[^>]*\brel="modulepreload"[^>]*>/gi) || []).length;
html = html.replace(/<link\b[^>]*\brel="modulepreload"[^>]*>/gi, '');

// ---------------------------------------------------------------------------
// 3. STYLESHEET LINK(S) — link the merged CSS asset(s) (see header §3).
// ---------------------------------------------------------------------------

// cssCodeSplit is off for the single classic bundle, so every app stylesheet
// lands in _app/immutable/assets/. Nothing references them in the fallback
// shell (Vite emits the asset without a chunk linkage), so inject a relative
// <link rel="stylesheet"> for each one.
const assetsDir = path.join(shellDir, '_app', 'immutable', 'assets');
let cssLinks = '';
let cssCount = 0;
if (existsSync(assetsDir)) {
  const cssFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.css')).sort();
  cssLinks = cssFiles
    .map((f) => `<link rel="stylesheet" href="./_app/immutable/assets/${f}" />`)
    .join('\n    ');
  cssCount = cssFiles.length;
}

// ---------------------------------------------------------------------------
// 4. Absolute → relative asset paths (the file:// blank-grey-screen fix).
// ---------------------------------------------------------------------------

// String literals pointing into /_app/ — attribute values and any remaining
// import specifiers. Single-quoted variants are included for future-
// proofing; runtime fetch('/api/…') strings are NOT touched (only /_app/ is
// rewritten, never /api/ or other roots).
html = html.replaceAll('"/_app/', '"./_app/').replaceAll("'/_app/", "'./_app/");

// Root-relative attribute references (favicon, manifest, icons…). The
// (?!\/) guard keeps protocol-relative "//host" URLs untouched.
const attrRewrites = html.match(/\s(?:href|src)="\/(?!\/)/g);
html = html.replace(/\s(href|src)="\/(?!\/)/g, ' $1="./');
html = html.replace(/\s(href|src)='\/(?!\/)/g, " $1='./");

// ---------------------------------------------------------------------------
// 5. On-screen boot diagnostics (plain script, first thing in <head>).
// ---------------------------------------------------------------------------

// Plain ES2017 — NO optional chaining / nullish coalescing / template
// literals: this script must run even on the old TV engine BEFORE any
// build-target downleveling question is settled. It registers FIRST so the
// error handlers are active before any asset starts loading.
const bootOverlayScript = `<script>/* mavero-wgt-boot-overlay: on-screen boot diagnostics for the TV (retail sets have no devtools/sdb logs). Registered before every asset so any boot failure becomes readable text on screen. */
(function () {
  if (window.__maveroBootDiag) return;
  window.__maveroBootDiag = true;
  var OVERLAY_ID = 'mavero-wgt-boot-overlay';
  var BANNER_ID = 'mavero-wgt-boot-banner';
  var booted = false;
  var overlayVisible = false;

  function make(tag, css, text) {
    var node = document.createElement(tag);
    node.setAttribute('style', css);
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function hideBanner() {
    try {
      var b = document.getElementById(BANNER_ID);
      if (b) b.style.display = 'none';
    } catch (e) {}
  }

  function paint(kind, message, source, stack) {
    try {
      hideBanner();
      var ov = document.getElementById(OVERLAY_ID);
      if (!ov) {
        ov = make('div',
          'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;background:#0b0f14;color:#d7e3ef;' +
            'font:13px/1.55 monospace;padding:22px;overflow:auto;white-space:pre-wrap;word-break:break-all;display:none;');
        ov.id = OVERLAY_ID;
        ov.appendChild(make('div', 'font-size:19px;font-weight:bold;color:#ff7b72;margin-bottom:10px;',
          'MAVERO boot error (TV diagnostics)'));
        (document.body || document.documentElement).appendChild(ov);
      }
      overlayVisible = true;
      var entry = make('div', 'border-top:1px solid #223142;padding:9px 0;margin-top:6px;');
      entry.appendChild(make('div', 'color:#ff7b72;font-weight:bold;',
        String(kind + (message ? ' — ' + message : '')).slice(0, 600)));
      if (source) entry.appendChild(make('div', 'color:#8fa8bf;margin-top:3px;', 'source: ' + String(source).slice(0, 600)));
      if (stack) entry.appendChild(make('div', 'color:#5f7386;font-size:11px;margin-top:4px;', String(stack).slice(0, 1600)));
      ov.appendChild(entry);
      ov.style.display = 'block';
    } catch (e) {}
  }

  // capture phase — resource load errors do not bubble to the window
  window.addEventListener('error', function (ev) {
    try {
      var t = ev.target;
      if (t && t !== window && t.tagName) {
        if (booted) return; // late noise (analytics trackers etc.) must not cover a working app
        var url = t.src || t.href || '(unknown url)';
        paint('failed to load ' + String(t.tagName).toLowerCase(), null, url, null);
        return;
      }
      paint('error', ev.message,
        ev.filename ? ev.filename + ' @ ' + ev.lineno + ':' + ev.colno : null,
        ev.error && ev.error.stack ? ev.error.stack : null);
    } catch (e) {}
  }, true);

  window.addEventListener('unhandledrejection', function (ev) {
    try {
      var r = ev && ev.reason;
      paint('unhandled rejection',
        r && (r.message || String(r)) ? r.message || String(r) : '(no reason)',
        null,
        r && r.stack ? r.stack : null);
    } catch (e) {}
  });

  // once the app is running, Back/Escape dismiss the overlay (it must not trap the UI)
  window.addEventListener('keydown', function (ev) {
    try {
      if (!overlayVisible || !booted) return;
      if (ev.keyCode === 10009 || ev.keyCode === 27 || ev.key === 'Back' || ev.key === 'Escape') {
        var ov = document.getElementById(OVERLAY_ID);
        if (ov) { ov.style.display = 'none'; overlayVisible = false; }
      }
    } catch (e) {}
  });

  // The SPA reports itself booted by rendering any element under the mount
  // wrapper. The static shell markup parsed at startup (direct children of
  // <body>) does NOT count; non-rendered elements (scripts/styles/…) never
  // count.
  function markBooted() {
    if (booted) return;
    booted = true;
    hideBanner();
  }
  try {
    if (typeof MutationObserver !== 'undefined') {
      var skip = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, BASE: 1, TITLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
      new MutationObserver(function (muts) {
        if (booted) return;
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.nodeType !== 1) continue;
            if (n.id === OVERLAY_ID || n.id === BANNER_ID) continue;
            if (skip[n.tagName]) continue;
            var p = n.parentNode;
            if (p && p.nodeType === 1 && p.tagName !== 'BODY' && p !== document.documentElement) {
              markBooted();
              return;
            }
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
  } catch (e) {}

  // Visible from the first millisecond, before any stylesheet: distinguishes
  // "truly blank" from "CSS loaded but JS failed" on a TV with no devtools.
  try {
    var banner = make('div',
      'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483646;background:#0b0f14;color:#8fa8bf;' +
        'display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:sans-serif;');
    banner.id = BANNER_ID;
    banner.appendChild(make('div', 'font-size:30px;color:#eef4fa;letter-spacing:3px;font-weight:700;', 'MAVERO'));
    banner.appendChild(make('div', 'font-size:17px;margin-top:14px;', 'Mavero booting\\u2026'));
    banner.appendChild(make('div', 'font-size:12px;margin-top:26px;color:#41576d;', 'TV boot diagnostics active'));
    (document.body || document.documentElement).appendChild(banner);
  } catch (e) {}
})();
</script>`;

// Runs FIRST in <head> (right after the diagnostics script), before the
// bundle is evaluated, so the router reads the normalized location at boot.
// history.state is preserved (the router's own seeded state must survive).
// On engines that forbid replaceState across file:// paths the guard catches
// the SecurityError and the shell stays on the literal /index.html URL —
// with relative asset paths + the hash router both entry URLs resolve
// correctly anyway.
const bootScript = `<script>/* mavero-wgt-boot: normalize the Tizen widget entry URL (…/index.html) to the package root before the SvelteKit router boots */
try {
  if (/\\/index\\.html$/.test(location.pathname)) {
    history.replaceState(history.state, '', location.href.replace(/index\\.html$/, ''));
  }
} catch (e) {}</script>`;

const headInjection = cssCount > 0 ? `${bootOverlayScript}${bootScript}\n    ${cssLinks}\n    ${tvModeStyleTag}` : `${bootOverlayScript}${bootScript}\n    ${tvModeStyleTag}`;
html = html.replace('<head>', `<head>${headInjection}`);

// ---------------------------------------------------------------------------
// 6. Self-assertions — fail the CI job loudly instead of shipping a
//    blank-grey-screen widget.
// ---------------------------------------------------------------------------

const problems = [];
if (html.includes('"/_app/') || html.includes("'/_app/")) {
  problems.push('an absolute "/_app/" or \u0027/_app/\u0027 reference survived the rewrite');
}
if (!/href="\.\/_app\//.test(html)) {
  problems.push('no relative href="./_app/…" found — rewrite did not apply');
}
if (!html.includes('src="./app.js" defer')) {
  problems.push('no classic <script src="./app.js" defer> boot tag — the ES-module bootstrap was not replaced');
}
if (/type=["']module["']/i.test(html)) {
  problems.push('a type="module" script survived — ES modules are blocked on the TV file:// origin');
}
if (html.includes('import(')) {
  problems.push('a dynamic import( survived in the shell — blocked on the TV file:// origin');
}
if (html.includes('modulepreload')) {
  problems.push('a modulepreload link survived — ES-chunk preloads are refused on the TV');
}
if (!html.includes(`window.__sveltekit_${kitHash} =`)) {
  problems.push(`the classic env global (window.__sveltekit_${kitHash}) is missing`);
}
if (!html.includes('__mavero_wgt_app')) {
  problems.push('the boot script does not reference the IIFE global __mavero_wgt_app');
}
if (cssCount > 0 && !/href="\.\/_app\/immutable\/assets\/[^"]+\.css"/.test(html)) {
  problems.push('emitted stylesheet asset(s) are not linked from the shell — the TV would boot unstyled');
}
if (cssCount === 0) {
  problems.push('no stylesheet asset found under _app/immutable/assets — the TV would boot unstyled');
}
if (html.includes('cloud.umami.is')) {
  problems.push('the Umami Cloud loader survived — it SyntaxErrors on the TV engine and is useless on TV');
}
if (!html.includes('mavero-wgt-boot')) {
  problems.push('boot URL-normalization script missing');
}
if (!html.includes('mavero-wgt-boot-overlay')) {
  problems.push('boot-error overlay missing');
}
if (!html.includes('mavero-wgt-boot-banner')) {
  problems.push('boot banner missing');
}

// §6 — polyfill assertions: the file must sit at the widget root, the shell
// must load it BEFORE the bundle, and it must define the three APIs the TV
// actually lacks (the crash list from the boot overlay).
if (!existsSync(polyfillTargetPath)) {
  problems.push('polyfill.js was not written to the widget root');
} else if (statSync(polyfillTargetPath).size === 0) {
  problems.push('polyfill.js at the widget root is empty');
}
const polyfillTagIndex = html.indexOf('<script src="./polyfill.js"></script>');
const bundleTagIndex = html.indexOf('<script src="./app.js" defer></script>');
if (polyfillTagIndex === -1) {
  problems.push('no <script src="./polyfill.js"> tag in the shell — the polyfill would never load');
}
if (bundleTagIndex === -1) {
  problems.push('no <script src="./app.js" defer> boot tag in the shell');
}
if (polyfillTagIndex !== -1 && bundleTagIndex !== -1 && polyfillTagIndex > bundleTagIndex) {
  problems.push('the polyfill script tag comes AFTER the bundle tag — the globals would be missing at module evaluation');
}
if (!/Object\.hasOwn\s*=/.test(polyfillSource)) {
  problems.push('polyfill.js does not define Object.hasOwn — the TV boot crash would persist');
}
if (!/String\.prototype\.replaceAll\s*=/.test(polyfillSource)) {
  problems.push('polyfill.js does not define String.prototype.replaceAll');
}
if (!/WeakRef/.test(polyfillSource)) {
  problems.push('polyfill.js does not define a WeakRef shim');
}

// §7 — TV mode assertions: the Stage-4 layout layer must be present and the
// body-class activation script must exist (both only ever touch the packed
// shell — the production web build never runs this script).
if (!html.includes('mavero-tv-mode')) {
  problems.push('the <style id="mavero-tv-mode"> Stage-4 TV layout layer is missing');
}
if (!html.includes('body.tv-mode {')) {
  problems.push('the tv-mode stylesheet lost its body.tv-mode root rule');
}
if (!html.includes('mavero-wgt-tv-mode')) {
  problems.push('the body.tv-mode activation script is missing — TV layout would stay inert');
}
if (!/body\.tv-mode \.mc-poster::before/.test(html) || !/padding-top:\s*150%/.test(html)) {
  problems.push('the engine-proof 2:3 poster geometry fallback (padding-top:150%) is missing');
}

if (problems.length > 0) {
  console.error('wgt_patch_shell: PATCH FAILED self-verification:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

writeFileSync(target, html);
const attrCount = attrRewrites ? attrRewrites.length : 0;
console.log(
  `wgt_patch_shell: patched the built shell — module bootstrap replaced with the classic ` +
    `boot (env global __sveltekit_${kitHash} + <script src="./polyfill.js"> + <script src="./app.js" defer>), ` +
    `polyfill.js written to the widget root (${polyfillWrittenBytes} bytes), ` +
    `${modulePreloadCount} modulepreload link(s) stripped, ${umamiRemoved} Umami loader ` +
    `block(s) removed, ${cssCount} stylesheet link(s) injected, absolute asset paths rewritten ` +
    `(/_app/ strings + ${attrCount} href/src attributes), boot URL normalizer + on-screen ` +
    `boot diagnostics injected, Stage-4 tv-mode layout layer injected (body class + ` +
    `${Math.round(tvModeCss.length / 1024)}KB CSS)`
);
