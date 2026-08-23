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

// Deterministic transition and autoplay guards.
assert.match(source, /function preloadImage/);
assert.match(source, /async function changeGallerySlide/);
assert.match(source, /galleryTransitioning/);
assert.match(source, /transitionToken/);
assert.match(source, /galleryTransitionTimer = setTimeout/);
assert.match(source, /clearGalleryTimers/);
assert.match(source, /visibilitychange/);
assert.match(source, /prefers-reduced-motion: reduce/);
assert.match(source, /disabled=\{galleryTransitioning\}/);

// Primary hero image and metadata/action accessibility contract.
assert.match(source, /<picture>/);
assert.match(source, /srcset=\{activeHero\.item\.backdropSmall \|\| activeHeroImage\}/);
assert.match(source, /fetchpriority=\{activeIndex === 0 \? 'high' : 'auto'\}/);
assert.match(source, /loading=\{activeIndex === 0 \? 'eager' : 'lazy'\}/);
assert.match(source, /No description available/);
assert.match(source, /aria-roledescription="carousel"/);
assert.match(source, /aria-label="Previous title"/);
assert.match(source, /aria-label="Next title"/);
assert.match(source, /role="tablist"/);
assert.match(source, /aria-label=\{`Add \$\{activeHero\.item\.title\} to My List`\}/);

// The retired multi-layer/GSAP implementation must not return.
assert.doesNotMatch(source, /GALLERY_SEQUENCE/);
assert.doesNotMatch(source, /gallerySlides\.length === 6/);
assert.doesNotMatch(source, /data-gallery-card/);
assert.doesNotMatch(source, /class="hero-stack"/);
assert.doesNotMatch(source, /import\('gsap'\)/);
assert.doesNotMatch(source, /timeline\.fromTo/);
assert.doesNotMatch(source, /timeline\.to/);

console.log('Discover single-active hero contract tests passed');
