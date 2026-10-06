import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// MAVERO — Follow-up task 2 regression contract:
// "FINAL UI/UX CORRECTION + RESPONSIVE CAROUSEL HARDENING"
//
// Covers every §-requirement of the follow-up task that is not already
// asserted by explorer_page_test.ts / explorer_navigation_test.ts:
//
//   A. SPOTLIGHT LAYOUT   — edge arrows (left/right, vertically centered),
//                           bottom-center dots, no "MAVERO / Spotlight"
//                           eyebrow, no bottom-right dock, per-breakpoint
//                           responsive heights, CTA/dots separation.
//   B. SPOTLIGHT AUTOPLAY — exactly 4000ms, RE-QUEUE after every automatic
//                           advance, manual navigation resets the countdown,
//                           NO 8s interaction-release window, one timer
//                           entry point (no duplicate timers), Discover hero
//                           shares the exact same lifecycle.
//   C. FILTER UI          — no visible GENRE/LANGUAGE labels (aria kept),
//                           exactly ONE Language "All" (data-contract fix,
//                           not CSS hiding), sticky-enabling ancestor fix.
//   D. SHOW MORE          — the sort URL dimension is closed-union
//                           validated end-to-end (page loader + feed).
//   E. RAIL ARROWS        — visible by default on pointer surfaces (not
//                           hover-only), disabled at the actual scroll ends,
//                           still hidden on ≤640px phones.
//   F. BOTTOM NAV         — reusable clearance token, applied across the
//                           whole ≤1024px pill range.
//   G. MEDIACARD          — Play stays fully opaque when the button ITSELF
//                           is hovered; poster elevation follows.
//   H. SCOPE              — protected areas untouched (search freeze,
//                           watch-href contract, page-shell clip semantics).

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const spotlight = read('../src/lib/components/SpotlightCarousel.svelte');
const discoverPage = read('../src/lib/components/DiscoverPage.svelte');
const explorerPage = read('../src/lib/components/ExplorerPage.svelte');
const contentRail = read('../src/lib/components/ContentRail.svelte');
const mediaCard = read('../src/lib/components/MediaCard.svelte');
const taxonomy = read('../src/lib/shared/explorer-taxonomy.ts');
const loader = read('../src/lib/server/content/explorer-load.ts');
const feedEndpoint = read('../src/routes/api/explorer/feed/+server.ts');
const appCss = read('../src/app.css');
const searchPage = read('../src/routes/search/+page.svelte');

// ============================================================
// A. SPOTLIGHT LAYOUT (§3/§12)
// ============================================================
// Edge arrows: left/right edges, vertically centered.
assert.match(spotlight, /\.spotlight-arrow \{\s*position: absolute; top: 50%; transform: translateY\(-50%\);/, 'spotlight arrows are vertically centered edge controls');
assert.match(spotlight, /\.spotlight-arrow-prev \{ left: clamp\(12px, 2vw, 24px\); \}/, 'prev arrow sits at the LEFT edge of the spotlight');
assert.match(spotlight, /\.spotlight-arrow-next \{ right: clamp\(12px, 2vw, 24px\); \}/, 'next arrow sits at the RIGHT edge of the spotlight');
assert.match(spotlight, /aria-label="Previous spotlight title"[\s\S]*?aria-label="Next spotlight title"/, 'arrows keep their accessible names');
assert.match(spotlight, /width: 46px; height: 46px;/, 'spotlight arrows are slightly larger than rail arrows (primary hero control)');
assert.match(spotlight, /aria-label="Previous spotlight title"/, 'arrow control is a semantic labeled button');
// Dots: bottom center, independent of the CTA row.
assert.match(spotlight, /\.spotlight-dots \{\s*position: absolute; bottom: 22px; left: 50%; transform: translateX\(-50%\);/, 'dots are positioned at the BOTTOM CENTER of the spotlight');
assert.match(spotlight, /padding: clamp\(28px, 4\.5vh, 52px\) clamp\(20px, 4vw, 48px\) 92px;/, 'the content layer reserves bottom space so the CTA row and dots never collide');
assert.match(spotlight, /role="tablist" aria-label="Choose spotlight title"/, 'dots remain a labeled tablist');
// Removals: no eyebrow, no bottom-right dock.
assert.doesNotMatch(spotlight, /MAVERO \/ Spotlight/, 'no "MAVERO / Spotlight" eyebrow on populated slides');
assert.doesNotMatch(spotlight, /spotlight-nav/, 'the old bottom-right navigation dock is GONE');
assert.doesNotMatch(spotlight, /\.spotlight-nav \{ position: absolute; bottom: 12px; right:/, 'no combined prev+dots+next capsule');
// Responsive heights: one per breakpoint, viewport-height aware.
assert.match(spotlight, /min-height: clamp\(420px, 56dvh, 620px\);/, 'desktop/TV spotlight height is spacious and viewport-height aware');
assert.match(spotlight, /@media \(min-width: 641px\) and \(max-width: 1024px\)\s*\{[\s\S]*?min-height: clamp\(360px, 48dvh, 480px\);/, 'tablet spotlight height is its own breakpoint model');
assert.match(spotlight, /@media \(max-width: 640px\)\s*\{[\s\S]*?min-height: clamp\(300px, 44dvh, 400px\);/, 'mobile stays cinematic but compact (first rail still begins naturally)');
// Play/More-details grouping + routes preserved.
assert.match(spotlight, /class="slide-actions"/, 'Play and More details stay grouped in one CTA row');
assert.match(spotlight, /\/watch\/\$\{slide\.type\}\/\$\{slide\.id\}/, 'Play keeps the existing watch route');
ok('A. spotlight layout: edge arrows, bottom-center dots, no eyebrow, no dock, responsive per-breakpoint heights');

// ============================================================
// B. SPOTLIGHT + DISCOVER AUTOPLAY (§4/§5) — the exact 4s contract
// ============================================================
for (const [name, src, constant] of [['Spotlight', spotlight, 'SPOTLIGHT_ROTATION_MS'], ['Discover hero', discoverPage, 'GALLERY_ROTATION_MS']] as const) {
  assert.match(src, new RegExp(`const ${constant} = 4000;`), `${name}: rotation interval is exactly 4000ms`);
  // THE core fix: the timer callback re-queues after advancing.
  const timerBody = src.match(new RegExp(`${constant}\\);`));
  assert.ok(timerBody, `${name}: the rotation timer is set with the 4000ms constant`);
  assert.match(
    src,
    /setTimeout\(\(\) => \{\s*\n?\s*[\s\S]*?scrollToSlide\(\(activeIndex \+ 1\) %[^\n]*\n[\s\S]*?queue(Rotation|GalleryRotation)\(\);/,
    `${name}: the timer callback ADVANCES and RE-QUEUES (continuous 4s cadence — the old code stopped after one tick)`
  );
  // One deterministic timer: clear-before-set.
  assert.match(src, /if \((rotationTimer|galleryRotationTimer)\) clearTimeout\(\1\);[\s\S]*?\1 = setTimeout/, `${name}: queueRotation always clears before setting (no duplicate timers)`);
  // Manual navigation resets the countdown to a full interval.
  assert.match(src, /function manual(Nav|HeroNav)\(index: number\) \{\s*\n?\s*scrollToSlide\(index, true\);\s*\n?\s*queue(Rotation|GalleryRotation)\(\);/, `${name}: manual navigation shows the slide immediately and resets the countdown`);
  // The 8s interaction-release window is gone.
  assert.doesNotMatch(src, /ROTATION_MS \* 2/, `${name}: no 8-second interaction release window`);
  assert.doesNotMatch(src, /releaseInteractionPause|interactionReleaseTimer|releaseTimer/, `${name}: the release-timer mechanism is removed`);
  // Interaction pause semantics preserved.
  assert.match(src, /onpointerenter=\{(pause|pauseGallery)\}/, `${name}: pointer over the carousel pauses`);
  assert.match(src, /onpointerleave=\{(resume|resumeGallery)\}/, `${name}: leaving restores the autoplay lifecycle`);
  assert.match(src, /onfocusin=\{(pause|pauseGallery)\}/, `${name}: keyboard focus inside pauses`);
  assert.match(src, /onfocusout=\{(resume|resumeGallery)\}/, `${name}: focus leaving restores autoplay`);
  assert.match(src, /visibilitychange/, `${name}: document visibility pauses/re-queues`);
  assert.match(src, /prefers-reduced-motion: reduce/, `${name}: reduced motion disables automatic movement`);
}
ok('B. autoplay: exactly 4s, re-queue after every advance, manual resets countdown, no 8s release, pause semantics kept (Spotlight + Discover)');

// ============================================================
// C. FILTER UI (§6/§7/§8)
// ============================================================
// Visible labels removed, accessible semantics retained.
assert.doesNotMatch(explorerPage, /chip-row-label/, 'no visible GENRE/LANGUAGE row label renders');
assert.doesNotMatch(explorerPage, />Genre<\/span>|SlidersHorizontal/, 'no Genre label text or icon');
assert.doesNotMatch(explorerPage, />Language<\/span>/, 'no Language label text');
assert.match(explorerPage, /role="group" aria-label=\{`Filter \$\{labels\.prose\} by genre`\}/, 'genre row keeps its accessible group label');
assert.match(explorerPage, /role="group" aria-label=\{`Filter \$\{labels\.prose\} by language`\}/, 'language row keeps its accessible group label');
// Exactly ONE Language All — fixed in the DATA, not hidden with CSS.
const languageListBlock = taxonomy.slice(taxonomy.indexOf('const MOVIE_SERIES_LANGUAGES'), taxonomy.indexOf('export const EXPLORER_LANGUAGES'));
assert.doesNotMatch(languageListBlock, /value: 'all'/, 'the movie/series language list carries NO all entry (the synthetic chip is the one All)');
const animeListBlock = taxonomy.slice(taxonomy.indexOf('const ANIME_LANGUAGES'), taxonomy.indexOf('// ============================================================\n// Follow-up task 2 (§10)'));
assert.doesNotMatch(animeListBlock, /value: 'all'/, 'the anime language list carries NO all entry');
assert.match(explorerPage, /data-chip-row="language"[\s\S]*?aria-label="All languages"[\s\S]*?>All<\/button>/, 'the language row renders exactly ONE synthetic All chip');
// Count the synthetic All chips across BOTH rendered rows: exactly one
// per row (2 total) — the old data-driven duplicate is structurally gone.
const allChipCount = (explorerPage.match(/>All<\/button>/g) ?? []).length;
assert.ok(allChipCount === 2, `exactly two synthetic All chips render total (one per row — found ${allChipCount})`);
// Sticky-enabling ancestor fix: page-shell must NOT be a scroll container.
assert.match(appCss, /\.page-shell \{ overflow-x: clip;/, 'page-shell uses overflow-x: clip (clips without creating a scroll container — sticky works on mobile/tablet)');
assert.doesNotMatch(appCss, /\.page-shell \{ overflow-x: hidden/, 'page-shell no longer uses overflow-x: hidden (the sticky-breaking value)');
ok('C. filter UI: labels gone (aria kept), exactly one Language All (data fix), sticky ancestor fixed via overflow-x: clip');

// ============================================================
// D. SHOW MORE — closed-union sort dimension end-to-end (§10)
// ============================================================
assert.match(taxonomy, /export type ExplorerSort = 'popular' \| 'top-rated';/, 'the sort union is exactly popular | top-rated');
assert.match(taxonomy, /export function isExplorerSort\(/, 'closed-union sort validation exists');
assert.match(loader, /isExplorerSort\(sortParam\) \? sortParam : undefined/, 'the page loader validates the sort URL param against the closed union');
assert.match(loader, /filters\.sort\)/, 'an active sort counts as a filter (the full-collection state)');
assert.match(feedEndpoint, /isExplorerSort\(sort\)/, 'the feed endpoint validates sort');
assert.match(feedEndpoint, /INVALID_SORT/, 'invalid sort values are rejected with 400 (closed contract)');
assert.match(loader, /showMoreHref: `\$\{DESTINATION_ROUTES\[type\]\}\?sort=popular`/, 'Popular Show-more → the canonical ?sort=popular route');
assert.match(loader, /showMoreHref: `\$\{DESTINATION_ROUTES\[type\]\}\?sort=top-rated`/, 'Top Rated Show-more → the canonical ?sort=top-rated route');
// The full-collection state reuses EXISTING services (no new endpoint).
assert.match(loader, /if \(filters\.sort === 'popular' && !filters\.genre[\s\S]*?popular\(type, safePage\)/, 'popular continuation reuses the existing popular() service');
assert.match(loader, /sort: filters\.sort === 'top-rated' \? 'Top rated' : 'For you'/, 'top-rated continuation reuses the existing Top rated collection ordering');
// ContentRail: linkLabel prop with the unchanged default.
assert.match(contentRail, /linkLabel = 'View all',/, 'ContentRail gains the optional linkLabel prop');
assert.match(contentRail, /aria-label=\{`\$\{linkLabel\} \$\{title\}`\}/, 'the header CTA keeps its accessible name');
ok('D. show more: closed-union sort dimension (page + feed), canonical route targets, existing services only');

// ============================================================
// E. CONTENT RAIL ARROWS (§11)
// ============================================================
// Visible by default on pointer surfaces — the hover-only reveal is gone.
assert.doesNotMatch(contentRail, /\.rail-wrap:hover \.rail-nav \{ opacity: 1; \}/, 'the hover-only reveal rule is removed');
const railNavBaseRule = contentRail.match(/\.rail-nav \{[^}]*\}/)?.[0] ?? '';
assert.doesNotMatch(railNavBaseRule, /opacity: 0;/, 'the base rail-nav rule no longer starts transparent');
// Edge state: disabled at the actual scroll ends.
assert.match(contentRail, /disabled=\{atStart\}/, 'the prev arrow disables at the scroll start');
assert.match(contentRail, /disabled=\{atEnd\}/, 'the next arrow disables at the scroll end');
assert.match(contentRail, /function updateScrollState\(\)/, 'the edge state is derived from the real scroll position');
assert.match(contentRail, /onscroll=\{updateScrollState\}/, 'scroll events update the edge state');
assert.match(contentRail, /\.rail-nav:disabled \{\s*opacity: \.22;/, 'a disabled arrow is visibly off but keeps its layout slot (no jumpiness)');
assert.match(contentRail, /aria-label=\{`Scroll \$\{title\} left`\}/, 'rail arrows keep their accessible names');
// Scroll step stays ~2 cards.
assert.match(contentRail, /direction \* step \* 2/, 'the arrows scroll ~2 cards per click (intentional step)');
// Phones keep native swipe as primary.
assert.match(contentRail, /@media \(max-width: 640px\)\s*\{[\s\S]*?\.rail-nav \{ display: none; \}/, 'rail arrows stay hidden on ≤640px phones (native swipe primary)');
// Native scrolling is preserved (no JS replacement).
assert.match(contentRail, /overflow-x: auto/, 'native horizontal scrolling is preserved');
ok('E. rail arrows: visible by default on pointer surfaces, disabled at real ends, 2-card step, phones stay native');

// ============================================================
// F. BOTTOM NAV CLEARANCE (§14)
// ============================================================
assert.match(appCss, /--mobile-nav-clearance: calc\(96px \+ env\(safe-area-inset-bottom, 0px\)\);/, 'the reusable bottom-nav clearance token exists (nav height + offset + gap + safe-area)');
assert.match(explorerPage, /@media \(max-width: 1024px\)\s*\{\s*\n?\s*\.explorer-page \{ padding-bottom: var\(--mobile-nav-clearance, 96px\); \}/, 'the Explorer applies the clearance across the ENTIRE ≤1024px pill range');
ok('F. bottom nav: reusable clearance token applied to all three Explorers (phones AND tablets)');

// ============================================================
// G. MEDIACARD — Play-on-Play hover (§15)
// ============================================================
assert.match(mediaCard, /\.mc-play:hover \{ opacity: 1;[\s\S]*?\}/, 'Play keeps FULL opacity when the button ITSELF is hovered (the root-cause fix)');
assert.match(mediaCard, /\.mc-wrap:has\(\.mc-play:hover\) \.mc-poster, \.mc-wrap:has\(\.mc-play:focus-visible\) \.mc-poster/, 'the poster keeps its elevated treatment while Play is hovered/focused (no flicker)');
assert.match(mediaCard, /\.mc-wrap:has\(\.mc-card-link:hover\) \.mc-play, \.mc-wrap:has\(\.mc-card-link:focus-visible\) \.mc-play \{ opacity: 1;/, 'card-link hover/focus still reveals Play');
assert.match(mediaCard, /\.mc-play:focus-visible \{ opacity: 1;/, 'keyboard focus on Play still reveals it');
// The watch URL behavior is untouched.
assert.match(mediaCard, /watchHref = appendReturnTo\(item\.resumeHref \?\? `\/watch\/\$\{item\.type\}\/\$\{item\.id\}`/, 'the watch href contract is unchanged');
assert.doesNotMatch(mediaCard, /onmouseenter|onmousemove/, 'the hover fix is pure CSS (no JS hover handlers)');
ok('G. MediaCard: Play stays opaque on direct hover, poster elevation follows, watch href unchanged, CSS-only');

// ============================================================
// H. SCOPE — protected areas
// ============================================================
// Search freeze: the recent-searches row remains and no explorer
// architecture leaked (full contract pinned in explorer_navigation_test).
assert.match(searchPage, /class="recent-searches" aria-label="Recent searches"/, 'the approved recent-searches row remains');
assert.doesNotMatch(searchPage, /EXPLORER_GENRES|EXPLORER_LANGUAGES|api\/explorer/, 'no Explorer architecture leaked into search');
// The spotlight keyboard contract is preserved.
assert.match(spotlight, /event\.key === 'ArrowRight'/, 'keyboard arrow navigation still works on the spotlight');
assert.match(spotlight, /aria-roledescription="carousel"/, 'the spotlight stays a real carousel landmark');
// Reduced motion on the new surfaces.
assert.match(spotlight, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.spotlight-arrow \{ transition: none; \}/, 'new spotlight controls honor reduced motion');
ok('H. scope: search frozen (recent searches intact), keyboard + carousel semantics + reduced motion preserved');

console.log(`\nExplorer UI hardening tests passed (${passed} check groups).`);
