// MAVERO — LT-18 Explorer Hero Redesign: focused regression suite.
//
// Covers LT-18 §5 (Movies / TV Shows / Anime hero carousel redesigned to
// Discover's cinematic design language) with SOURCE-CONTRACT sections over
// SpotlightCarousel.svelte + ExplorerPage.svelte + the three routes.
//
// Directive case map (LT-18 §6F):
//   Movies / TV Shows / Anime mount the carousel ....... §A
//   cinematic full-bleed visual language ................ §B
//   content stack (kicker/title/meta/desc/CTAs) ......... §C
//   cinematic pagination + slide navigation ............. §D
//   autoplay timing + lifecycle .......................... §E
//   reduced motion ........................................ §F
//   route links preserved ................................ §G
//   lazy images + no extra backend calls ................. §H
//   filters/results architecture untouched ............... §I
//
// NO network, browser, DRM or Shaka package is involved.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
function ok(label: string): void {
        passed++;
        console.log(`  ok ${passed} - ${label}`);
}

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
const spotlight = read('../src/lib/components/SpotlightCarousel.svelte');
const explorer = read('../src/lib/components/ExplorerPage.svelte');
const discover = read('../src/lib/components/DiscoverPage.svelte');
const routes = {
        movies: read('../src/routes/movies/+page.svelte'),
        series: read('../src/routes/tv-shows/+page.svelte'),
        anime: read('../src/routes/anime/+page.svelte')
};

/** Slice a source string from a start marker to just before an end marker. */
function sliceOf(source: string, start: string, end: string): string {
        const from = source.indexOf(start);
        assert.ok(from !== -1, `marker not found: ${start}`);
        const to = source.indexOf(end, from + start.length);
        assert.ok(to !== -1, `end marker not found after ${start}: ${end}`);
        return source.slice(from, to);
}

// ============================================================
// §A — All three Explorers mount the redesigned carousel
// ============================================================
{
        for (const [key, source] of Object.entries(routes)) {
                assert.ok(
                        source.includes('spotlight={data.spotlight}'),
                        `${key} route passes the spotlight through (prop contract intact)`
                );
                assert.ok(
                        source.includes('ExplorerPage'),
                        `${key} route renders the shared ExplorerPage`
                );
        }
        // The public props/data contract is unchanged.
        assert.ok(spotlight.includes('items = []'), 'items prop preserved');
        assert.ok(spotlight.includes("ariaLabel = 'Spotlight'"), 'ariaLabel prop preserved');
        assert.ok(spotlight.includes('MAX_SLIDES = 6'), 'the 6-slide lineup window is preserved');
        ok('A. Movies / TV Shows / Anime all mount the carousel; props + 6-slide contract intact');
}

// ============================================================
// §B — Cinematic full-bleed visual language (no closed box)
// ============================================================
{
        const boxCss = sliceOf(spotlight, '.spotlight {', '\n  }');
        // Full-bleed: 100% width, NO border, NO radius, NO shadow, NO cap.
        assert.ok(boxCss.includes('width: 100%;'), 'the hero spans the full width');
        for (const banned of ['border:', 'border-radius', 'box-shadow', 'max-width', 'margin-inline']) {
                assert.ok(!boxCss.includes(banned), `the hero box carries no ${banned} (closed-card framing removed)`);
        }
        assert.ok(!spotlight.includes('width: 90%;'), 'the old ~90% boxed width is gone');
        // The backdrop fills the slide.
        const mediaCss = sliceOf(spotlight, '.slide-media img {', '\n  }');
        assert.ok(mediaCss.includes('object-fit: cover'), 'the artwork covers the slide');
        assert.ok(mediaCss.includes('width: 100%; height: 100%;') || mediaCss.includes('inset: 0'), 'the artwork fills the slide box');
        // The scrim fades into the page background (Discover's contract).
        const scrimCss = sliceOf(spotlight, '.slide-scrim {', '\n  }');
        assert.ok(
                scrimCss.includes('var(--color-bg) 100%'),
                'the bottom scrim dissolves into the page background (no hard edge)'
        );
        // Viewport-height slides (Discover's height model).
        assert.ok(
                spotlight.includes('min-height: min(78vh, 680px);'),
                'desktop slides are viewport-height (Discover model)'
        );
        // ExplorerPage lets the hero bleed from the very top.
        const pageBoxCss = sliceOf(explorer, '.explorer-page {', '\n  }');
        assert.ok(pageBoxCss.includes('padding-top: 0;'), 'the Explorer page removes its top padding for the bleed');
        ok('B. cinematic full-bleed: 100% width, no box framing, bg-fading scrim, viewport heights, top bleed');
}

// ============================================================
// §C — Content stack anchored bottom-left (Discover's language)
// ============================================================
{
        const contentCss = sliceOf(spotlight, '.slide-content {', '\n  }');
        assert.ok(contentCss.includes('align-items: flex-end'), 'content anchors toward the BOTTOM');
        const copyCss = sliceOf(spotlight, '.slide-copy {', '\n  }');
        assert.ok(copyCss.includes('max-width: 560px'), 'the copy block is width-capped like Discover');
        // Kicker -> title -> meta -> description -> actions.
        const copyBlock = sliceOf(spotlight, '<div class="slide-copy"', '</div>\n          </div>');
        const kickerAt = copyBlock.indexOf('class="slide-kicker"');
        const titleAt = copyBlock.indexOf('class="slide-title"');
        const metaAt = copyBlock.indexOf('class="slide-meta"');
        const descAt = copyBlock.indexOf('class="slide-desc"');
        const actionsAt = copyBlock.indexOf('class="slide-actions"');
        for (const at of [kickerAt, titleAt, metaAt, descAt, actionsAt]) assert.ok(at !== -1, 'copy member present');
        assert.ok(
                kickerAt < titleAt && titleAt < metaAt && metaAt < descAt && descAt < actionsAt,
                'stack order: kicker, title, meta line, description, actions'
        );
        // The kicker is the truthful type-derived category.
        assert.ok(
                spotlight.includes("item.type === 'movie' ? 'Movie' : item.type === 'series' ? 'Series' : 'Anime'"),
                'the kicker derives from the item type (Movie/Series/Anime — never invented)'
        );
        // Rating/year/genre metadata line with dot separators (Discover style).
        assert.ok(spotlight.includes('slide.rating.toFixed(1)'), 'the rating renders');
        assert.ok(spotlight.includes('{#if slide.year > 0}'), 'the year renders only when truthful');
        assert.ok(spotlight.includes('slide.genres.slice(0, 2)'), 'up to two genres render');
        // 2-line clamped description.
        const descCss = sliceOf(spotlight, '.slide-desc {', '\n  }');
        assert.ok(descCss.includes('-webkit-line-clamp: 2'), 'the description clamps to 2 lines');
        // Play + More details with 44px targets.
        assert.ok(spotlight.includes('<Play size={15} fill="currentColor" strokeWidth={0} /> Play'), 'the Play CTA is preserved');
        assert.ok(spotlight.includes('More details'), 'the More details CTA is preserved');
        const playCss = sliceOf(spotlight, '.slide-play, .slide-more {', '\n  }');
        assert.ok(playCss.includes('min-height: 44px'), 'CTAs keep the 44px touch target');
        ok('C. content stack: bottom-left anchor, kicker, prominent title, meta dots, 2-line desc, Play + More details');
}

// ============================================================
// §D — Cinematic pagination cluster + slide navigation
// ============================================================
{
        // The pagination cluster sits bottom-RIGHT: prev · dots · next.
        const navCss = sliceOf(spotlight, '.spotlight-nav {', '\n  }');
        assert.ok(navCss.includes('right:'), 'the cluster anchors to the right');
        assert.ok(navCss.includes('bottom:'), 'the cluster anchors to the bottom');
        const navBlock = sliceOf(spotlight, '<div class="spotlight-nav">', '{/if}');
        const prevAt = navBlock.indexOf('aria-label="Previous spotlight title"');
        const dotsAt = navBlock.indexOf('role="tablist" aria-label="Choose spotlight title"');
        const nextAt = navBlock.indexOf('aria-label="Next spotlight title"');
        for (const at of [prevAt, dotsAt, nextAt]) assert.ok(at !== -1, 'nav member present');
        assert.ok(prevAt < dotsAt && dotsAt < nextAt, 'cluster order: prev, dots, next');
        // The old edge-arrow implementation and centered dots are gone.
        assert.ok(!spotlight.includes('spotlight-arrow'), 'the old vertically-centered edge arrows are gone');
        assert.ok(
                !/\.spotlight-dots \{\s*position: absolute; bottom: 22px; left: 50%/.test(spotlight),
                'dots no longer sit alone at bottom-center on desktop'
        );
        // Mobile: arrows hidden, dots centered (Discover's mobile contract).
        const mobileCss = sliceOf(spotlight, '@media (max-width: 640px) {', '\n  }');
        assert.ok(mobileCss.includes('.spotlight-nav-btn { display: none; }'), 'mobile drops the arrows (swipe-first)');
        assert.ok(mobileCss.includes('right: 50%;'), 'mobile centers the dots');
        // Direct navigation: dots + arrows drive manualNav.
        assert.ok(spotlight.includes('onclick={() => manualNav(index)}'), 'dots navigate directly');
        assert.ok(
                spotlight.includes('manualNav((activeIndex - 1 + slides.length) % slides.length)') &&
                        spotlight.includes('manualNav((activeIndex + 1) % slides.length)'),
                'arrows navigate with wrapping'
        );
        // Active-slide treatment: copy fade-up + Ken Burns (not infinite drift).
        assert.ok(spotlight.includes('.spotlight-slide.active .slide-copy { opacity: 1;'), 'active copy fades up');
        assert.ok(spotlight.includes('.spotlight-slide.active .slide-media img { transform: scale(1.03); }'), 'active artwork gently scales');
        assert.ok(!spotlight.includes('@keyframes slide-drift'), 'the old infinite drift animation is gone');
        ok('D. cinematic pagination: bottom-right prev·dots·next cluster, mobile centered dots, active-slide treatment');
}

// ============================================================
// §E — Autoplay timing + lifecycle (the exact 4s contract)
// ============================================================
{
        assert.ok(spotlight.includes('const SPOTLIGHT_ROTATION_MS = 4000'), 'rotation stays 4 seconds');
        // Re-queue after every automatic advance.
        const queue = sliceOf(spotlight, 'function queueRotation() {', 'function pause()');
        assert.ok(queue.includes('queueRotation();'), 'the timer re-queues after each advance');
        // Manual navigation resets the countdown.
        const manual = sliceOf(spotlight, 'function manualNav(', 'function handleScroll()');
        assert.ok(manual.includes('queueRotation();'), 'manual navigation resets the countdown');
        // Pointer/focus pause + resume.
        assert.ok(spotlight.includes('onpointerenter={pause}'), 'pointer enter pauses');
        assert.ok(spotlight.includes('onpointerleave={resume}'), 'pointer leave resumes');
        // Visibility pause.
        assert.ok(spotlight.includes("document.addEventListener('visibilitychange', handleVisibility)"), 'visibility changes pause/resume');
        assert.ok(!/Math\.random/.test(spotlight), 'no render-time randomization (SSR/hydration stability)');
        ok('E. autoplay: 4s cadence, re-queue, manual reset, pointer/focus/visibility pause');
}

// ============================================================
// §F — Reduced motion
// ============================================================
{
        assert.ok(spotlight.includes('@media (prefers-reduced-motion: reduce)'), 'the reduced-motion block exists');
        const reduced = sliceOf(spotlight, '@media (prefers-reduced-motion: reduce) {', '</style>');
        assert.ok(reduced.includes('transform: none;'), 'Ken Burns is disabled under reduced motion');
        assert.ok(/opacity: 1; transform: none;/.test(reduced), 'the copy fade-up is disabled under reduced motion');
        assert.ok(spotlight.includes("window.matchMedia('(prefers-reduced-motion: reduce)')"), 'the runtime query drives rotation disabling');
        ok('F. reduced motion: no drift, no fade-up, no auto movement');
}

// ============================================================
// §G — Route links preserved
// ============================================================
{
        // MAV-20 Phase D: the links keep the SAME route patterns, now
        // wrapped in appendReturnTo(..., returnTo) so they carry the
        // Explorer origin as `from` for correct back-navigation.
        assert.ok(
                spotlight.includes('appendReturnTo(`/watch/${slide.type}/${slide.id}`, returnTo)'),
                'Play keeps the /watch/{type}/{id} pattern (with the Explorer origin)'
        );
        assert.ok(
                spotlight.includes('appendReturnTo(`/${slide.type}/${slide.id}`, returnTo)'),
                'More details keeps the /{type}/{id} pattern (with the Explorer origin)'
        );
        assert.ok(spotlight.includes('aria-roledescription="carousel"'), 'the carousel landmark is preserved');
        assert.ok(spotlight.includes('role="tab"'), 'dots remain tab semantics');
        // Keyboard controls survive.
        for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
                assert.ok(spotlight.includes(`'${key}'`), `keyboard ${key} control preserved`);
        }
        ok('G. route links, carousel semantics and keyboard controls all preserved');
}

// ============================================================
// §H — Lazy images + no extra backend calls
// ============================================================
{
        // Non-active slides lazy-load; the first is eager + high priority.
        assert.ok(spotlight.includes("loading={index === 0 ? 'eager' : 'lazy'}"), 'non-active slides lazy-load');
        assert.ok(spotlight.includes("fetchpriority={index === 0 ? 'high' : 'auto'}"), 'the first slide is prioritized');
        assert.ok(spotlight.includes('sizes="100vw"'), 'artwork is 100vw-sized (full-bleed)');
        // No backend calls of any kind from the carousel.
        assert.ok(!spotlight.includes('fetch('), 'the carousel never fetches');
        assert.ok(!spotlight.includes('/api/'), 'the carousel never calls app APIs');
        ok('H. lazy non-active artwork, 100vw sizing, zero backend calls');
}

// ============================================================
// §I — Filters/results architecture untouched below the hero
// ============================================================
{
        // The Explorer filtering/results machinery is intact.
        assert.ok(explorer.includes('updateFilters'), 'URL-driven filter updates survive');
        assert.ok(explorer.includes('toggleGenre'), 'genre chips survive');
        assert.ok(explorer.includes('toggleLanguage'), 'language chips survive');
        assert.ok(explorer.includes('loadMore'), 'the feed pagination survives');
        assert.ok(explorer.includes('topUpToResponsiveTarget'), 'the responsive first-batch top-up survives');
        assert.ok(explorer.includes('<ContentRail'), 'the unfiltered sections survive');
        assert.ok(explorer.includes('<MediaCard'), 'the filtered results grid survives');
        // The spotlight fallback (no lineup) keeps its own spacing.
        const fallbackCss = sliceOf(explorer, '.explorer-hero-fallback {', '\n  }');
        assert.ok(fallbackCss.includes('margin: 14px auto 0;'), 'the fallback block keeps its top margin');
        ok('I. Explorer filtering/results architecture untouched below the hero');
}

// ============================================================
// §J — No Discover regressions (Discover stays the reference)
// ============================================================
{
        // Discover's own hero implementation is untouched.
        assert.ok(discover.includes('class="hero"'), "Discover's hero markup is intact");
        assert.ok(discover.includes('GALLERY_ROTATION_MS = 4000'), "Discover's rotation is intact");
        assert.ok(discover.includes('.hero-nav {'), "Discover's pagination cluster is intact");
        ok('J. Discover behavior/implementation unchanged (the visual reference)');
}

console.log(`\nLT-18 Explorer hero redesign suite: ${passed} checks passed.`);
