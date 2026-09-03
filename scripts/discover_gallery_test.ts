import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/lib/components/DiscoverPage.svelte', import.meta.url), 'utf8');

// Single-authoritative featured-item contract.
assert.match(source, /const MAX_FEATURED_ITEMS = 6/);
assert.match(source, /function createFeaturedItems/);
assert.match(source, /featuredItems = createFeaturedItems/);
assert.match(source, /activeHero = featuredItems\[activeIndex\]/);
assert.match(source, /activeHeroImage = activeHero\?\.item\.backdrop/);
assert.match(source, /uniqueItems/);
assert.match(source, /hasHeroImage/);

// Carousel infrastructure — scroll-snap track with rotation, keyboard, reduced-motion, visibility.
assert.match(source, /function preloadImage/);
assert.match(source, /scrollToSlide/);
assert.match(source, /heroTrack/);
assert.match(source, /scroll-snap-type/);
assert.match(source, /galleryRotationTimer = setTimeout/);
assert.match(source, /clearTimers/);
assert.match(source, /visibilitychange/);
assert.match(source, /prefers-reduced-motion: reduce/);

// Primary hero image and metadata/action accessibility contract.
assert.match(source, /<picture>/);
assert.match(source, /fetchpriority=\{index === 0 \? 'high' : 'auto'\}/);
assert.match(source, /loading=\{index === 0 \? 'eager' : 'lazy'\}/);
assert.match(source, /No description available/);
assert.match(source, /aria-roledescription="carousel"/);
assert.match(source, /aria-label="Previous title"/);
assert.match(source, /aria-label="Next title"/);
assert.match(source, /role="tablist"/);

// The retired multi-layer/GSAP implementation must not return.
assert.doesNotMatch(source, /GALLERY_SEQUENCE/);
assert.doesNotMatch(source, /gallerySlides\.length === 6/);
assert.doesNotMatch(source, /data-gallery-card/);
assert.doesNotMatch(source, /class="hero-stack"/);
assert.doesNotMatch(source, /import\('gsap'\)/);
assert.doesNotMatch(source, /timeline\.fromTo/);
assert.doesNotMatch(source, /timeline\.to/);

console.log('Discover single-active hero contract tests passed');
