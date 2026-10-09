// ============================================================================
// MAV-24 — Cinematic Detail Page Final Polish (targeted 3-issue fix pass on
// top of MAV-23 9fce0f8).
//
//   Issue 1 — FIRST-VIEWPORT HIERARCHY: the hero synopsis/overview
//             paragraph is REMOVED from the hero; the Overview section
//             below the hero keeps the full synopsis + Show More.
//   Issue 2 — HERO ACTIONS: Play + icon-only Download in one aligned row;
//             icon-only fullscreen control beside Trailer Off (toggles
//             enter/exit); no separate fullscreen row; no "Fullscreen"
//             text; the over-player placement is documented as not
//             reliably possible (YouTube owns the bottom control bar of
//             the cross-origin iframe).
//   Issue 3 — PROVIDER FIELD: the "On <provider>" hero strip is REMOVED;
//             the same provider data renders as a labelled
//             STREAMING PROVIDER(S) field inside the existing More
//             Details grid (logo + name chips, wrapping, honest-empty,
//             palette-driven).
//
// Everything else in Cinematic Detail 3.0 must remain untouched — the
// regression sections below pin the preserved contracts.
// ============================================================================
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = (p: string) => readFileSync(p, 'utf8').toString();
const detailPage = read('src/lib/components/DetailPage.svelte');

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
}

// ============================================================
// 1. Issue 1 — hero synopsis REMOVED, Overview intact
// ============================================================
// The hero renders NO synopsis paragraph anywhere (markup + CSS).
ok(!/class="detail-desc"/.test(detailPage), 'I1: the hero synopsis element is gone from the markup');
ok(!/\.detail-desc\s*\{/.test(detailPage), 'I1: the hero synopsis CSS is gone (no orphaned rules)');
// The Overview section below the hero keeps the FULL synopsis + Show More.
ok(/<h2 class="section-h" id="overview-heading">Overview<\/h2>/.test(detailPage), 'I1: the Overview section remains below the hero');
ok(/<p class="overview-text" class:expanded=\{overviewExpanded\}>\{item\.description\}<\/p>/.test(detailPage), 'I1: Overview renders the full description');
ok(/\{overviewExpanded \? 'Show Less' : 'Show More'\}/.test(detailPage), 'I1: the Show More/Show Less expansion remains');
ok(/const hasLongOverview = \$derived\(item\.description\.length > 280\);/.test(detailPage), 'I1: the 280-char Show More threshold is unchanged');
// The hero still renders EVERYTHING else required in the first viewport.
for (const el of ['poster-card', 'detail-eyebrow', 'detail-title', 'meta-row', 'genre-chips', 'primary-actions', 'secondary-actions']) {
  ok(detailPage.includes(`class="${el}"`) || detailPage.includes(`class="${el} `) || new RegExp(`class="${el}[ "]`).test(detailPage), `I1: hero keeps .${el}`);
}
ok(/class="back-btn" type="button" onclick=\{goBack\} aria-label="Go back"/.test(detailPage), 'I1: back navigation preserved in the hero');
// Document order: the Overview heading must NOT be pulled into the hero —
// overview-section lives inside .detail-body AFTER .hero-body in the DOM.
{
  const heroBodyIdx = detailPage.indexOf('<div class="hero-body">');
  const detailBodyIdx = detailPage.indexOf('<div class="detail-body">');
  const overviewIdx = detailPage.indexOf('<section class="overview-section"');
  ok(heroBodyIdx > -1, 'I1: hero body structure intact');
  ok(detailBodyIdx > heroBodyIdx, 'I1: detail-body follows the hero body');
  ok(overviewIdx > detailBodyIdx, 'I1: Overview section is inside detail-body (below the hero, correct document order)');
  ok(overviewIdx < detailPage.indexOf('<section class="details-section"'), 'I1: Overview precedes More Details in document order');
}
// The mobile fold block no longer tunes a synopsis (nothing shrunk to fake it).
{
  const mobileBlock = detailPage.slice(detailPage.indexOf('@media (max-width: 640px)')).replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/detail-desc/.test(mobileBlock), 'I1: mobile block carries no synopsis rules (removal, not compression)');
  // No arbitrary font/poster/tap-target shrinking (sizes unchanged from MAV-23).
  ok(/\.play-btn\s*\{[^}]*min-height:\s*52px/.test(mobileBlock), 'I1: Play keeps its 52px tap target (not shrunk to compensate)');
  ok(/grid-template-columns:\s*clamp\(96px,\s*25vw,\s*124px\)/.test(mobileBlock), 'I1: mobile poster column unchanged (not shrunk to compensate)');
  ok(/\.detail-title\s*\{[^}]*font-size:\s*clamp\(1\.24rem,\s*5vw,\s*1\.6rem\)/.test(mobileBlock), 'I1: mobile title scale unchanged (not shrunk to compensate)');
}

// ============================================================
// 2. Issue 2 — primary row, icon-only Download, icon-only fullscreen
// ============================================================
// One aligned primary row: Play dominant + fixed-height icon Download.
ok(/class="primary-actions"/.test(detailPage) && /class="download-btn"/.test(detailPage), 'I2: Play and Download share the primary-actions row');
ok(!/<span>Download<\/span>/.test(detailPage), 'I2: the visible "Download" text is removed');
{
  const dl = detailPage.match(/<button class="download-btn"[^>]*>/)![0];
  ok(/aria-label=\{`Download \$\{item\.title\}`\}/.test(dl), 'I2: the Download icon button keeps an accessible name');
  ok(/onclick=\{openDownloadSheet\}/.test(dl) && /aria-haspopup="dialog"/.test(dl), 'I2: the Download click behavior is unchanged');
}
ok(/\.download-btn\s*\{[^}]*flex:\s*0 0 auto;\s*width:\s*52px;\s*min-height:\s*52px/.test(detailPage), 'I2: Download is a 52px square locked to the Play row height');
ok(/\.play-btn\s*\{[^}]*min-height:\s*52px/.test(detailPage), 'I2: Play keeps its 52px dominant target (consistent row height)');
ok(/\.primary-actions\s*\{[^}]*display:\s*flex;\s*align-items:\s*stretch/.test(detailPage), 'I2: the primary row stretches both buttons to one height');
// Fullscreen: icon-only, beside Trailer Off, no separate row, state-aware.
ok(!/<span>Fullscreen<\/span>/.test(detailPage), 'I2: the visible "Fullscreen" text is removed');
ok(/\{#if trailerActive\}[\s\S]{0,1000}?<button\s+class="secondary-btn trailer-fs-btn"/.test(detailPage), 'I2: the fullscreen control renders ONLY while the trailer is active (beside Trailer Off in the same secondary row — no dedicated row)');
ok(/aria-label=\{trailerFullscreen \? 'Exit trailer fullscreen' : 'Show trailer fullscreen'\}/.test(detailPage), 'I2: the fullscreen control has a state-aware accessible label');
ok(/aria-pressed=\{trailerFullscreen\}/.test(detailPage), 'I2: the fullscreen control announces its pressed state');
ok(/onclick=\{\(\) => \(trailerFullscreen \? exitTrailerFullscreen\(\) : enterTrailerFullscreen\(\)\)\}/.test(detailPage), 'I2: the fullscreen control toggles enter/exit');
ok(/\.trailer-fs-btn\s*\{[^}]*min-width:\s*44px/.test(detailPage), 'I2: the icon-only fullscreen control keeps a >=44px touch target');
// The over-player placement is DOCUMENTED as not reliably possible — the
// code must carry the honest limitation note (cross-origin YouTube owns
// the player's bottom control bar; a parent overlay would obscure it).
ok(/bottom-left[\s\S]{0,400}cross-origin/.test(detailPage.replace(/\n\s+/g, ' ')), 'I2: the over-player placement limitation is documented in-source');
// Trailer state contracts (unchanged from MAV-23).
ok(/\{trailerActive \? 'Trailer Off' : 'Trailer'\}/.test(detailPage), 'I2: the Trailer / Trailer Off toggle labels are unchanged');
ok((detailPage.match(/youtube\.com\/embed\//g) ?? []).length === 1, 'I2: exactly ONE inline YouTube embed (no duplicate players)');
ok(/autoplay=1&rel=0/.test(detailPage) && /allowfullscreen/.test(detailPage), 'I2: the embed source contract is unchanged');
ok(/if \(trailerActive\) stopTrailer\(\)/.test(detailPage), 'I2: navigating to another title stops the trailer (stale-playback guard)');
ok(/trailerToggle\?\.focus\(\)/.test(detailPage), 'I2: stopping the trailer restores focus to the toggle');
ok(/querySelector<HTMLElement>\('\.trailer-fs-btn'\)\?\.focus\(\)/.test(detailPage), 'I2: starting the trailer moves focus to the fullscreen control');
ok(/requestFullscreen/.test(detailPage) && /orientation\?\.lock/.test(detailPage), 'I2: guarded fullscreen + orientation-lock behavior preserved');

// ============================================================
// 3. Issue 3 — provider field in More Details, none in the hero
// ============================================================
ok(!/class="provider-strip"/.test(detailPage), 'I3: the hero provider strip is gone (no duplication in the hero)');
ok(!/MAX_HERO_PROVIDERS|heroProviders|heroProviderNames/.test(detailPage), 'I3: no hero-provider remnants (renamed/rescoped to the details grid)');
ok(/const detailProviders = \$derived\(\(item\.streamingProviders \?\? \[\]\)\.filter\(\(provider\) => provider\.name\?\.trim\(\)\)\);/.test(detailPage), 'I3: providers come from the REAL metadata (no hardcoded names)');
ok(/const providerFieldLabel = \$derived\(detailProviders\.length > 1 \? 'Streaming Providers' : 'Streaming Provider'\);/.test(detailPage), 'I3: the field uses a proper singular/plural label');
ok(/\{#if detailProviders\.length\}[\s\S]*?<dt class="fact-label">\{providerFieldLabel\}<\/dt>/.test(detailPage), 'I3: the provider field renders inside the More Details grid, gated on real data (no empty field)');
ok(/\{#each detailProviders as provider \(provider\.id\)\}/.test(detailPage), 'I3: EVERY provider renders (keyed; no 3-logo cap, no +N count)');
ok(/provider\.logo[\s\S]*?provider-logo[\s\S]*?\{:else\}[\s\S]*?provider-logo-fallback[\s\S]*?provider\.name\.slice\(0, 1\)/.test(detailPage), 'I3: logoless providers fall back to the initial monogram');
ok(/class="provider-chip"/.test(detailPage) && /class="provider-chip-name"/.test(detailPage), 'I3: each provider renders as a logo+name chip');
ok(/class="provider-list"/.test(detailPage) && /\.provider-list\s*\{[^}]*flex-wrap:\s*wrap/.test(detailPage), 'I3: the provider list wraps (multiple providers never overflow the grid)');
ok(/\{#if factRows\.length \|\| detailProviders\.length\}/.test(detailPage), 'I3: the More Details section renders when EITHER facts OR providers exist');
// Grid placement: the provider field is the FIRST field of the grid.
{
  const gridIdx = detailPage.indexOf('<dl class="details-grid">');
  const provIdx = detailPage.indexOf('fact-row-providers');
  const factIdx = detailPage.indexOf('{#each factRows as fact (fact.label)}');
  ok(gridIdx > -1 && provIdx > gridIdx && provIdx < factIdx, 'I3: the provider field is the first field inside the details grid');
}
// Palette continuity: the field uses the title-palette tokens.
ok(/\.provider-chip\s*\{[^}]*var\(--dp-accent-border\)/.test(detailPage), 'I3: provider chips follow the poster-derived palette (border)');
ok(/\.provider-chip\s*\{[^}]*var\(--dp-surface\)/.test(detailPage), 'I3: provider chips follow the poster-derived palette (surface)');

// ============================================================
// 4. Non-regression — Cinematic Detail 3.0 preserved
// ============================================================
// Composition + palette (MAV-22/23 contracts spot-checked; full suites run).
ok(/<div class="detail-page" style=\{paletteStyle\}>/.test(detailPage), 'R: the palette-canvas page scope is untouched');
ok(/class="palette-canvas" class:active=\{paletteStyle !== ''\}/.test(detailPage), 'R: the palette fade-in gate is untouched');
ok(/class="trailer-inline" bind:this=\{trailerContainer\}/.test(detailPage), 'R: the inline trailer container is untouched');
ok(/downloadSheetOpen/.test(detailPage) && /paletteStyle=\{paletteStyle\}/.test(detailPage), 'R: the Download sheet + its palette prop wiring are untouched');
ok(/onDownload=\{openEpisodeDownloadSheet\}/.test(detailPage), 'R: episode download flow untouched');
ok(/<SeasonEpisodes[\s\S]*?watchType=\{type === 'anime' \? 'anime' : 'series'\}/.test(detailPage), 'R: season/episode guide untouched');
ok(/class="cast-rail"/.test(detailPage) && /class="recs-row"/.test(detailPage), 'R: Cast + recommendation rails untouched');
ok(/navigateBackOr/.test(detailPage) && /appendReturnTo/.test(detailPage), 'R: back navigation + return-to contracts untouched');
ok(/<script type="application\/ld\+json">\{structuredData\}<\/script>/.test(detailPage), 'R: SEO structured data untouched');
ok(/structuredData = \$derived\(JSON\.stringify/.test(detailPage), 'R: metadata enrichment untouched');
// The removed pieces did not orphan any dead code.
ok(!/heroProviderOverflow|provider-strip-label|provider-logos\b|provider-names|provider-more/.test(detailPage), 'R: no dead provider-strip code remains');
ok(!/detail-desc/.test(detailPage.replace(/\/\* MAV-24[^*]*\*\//g, '')), 'R: no dead detail-desc code remains (comments aside)');

console.log(`\nMAV-24 final polish tests passed (${passed} checks).`);
