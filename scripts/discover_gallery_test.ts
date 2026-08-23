import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/lib/components/DiscoverPage.svelte', import.meta.url), 'utf8');

// Rotation / sequencing contract
assert.match(source, /const GALLERY_ROTATION_MS = 6500/);
assert.match(source, /const GALLERY_TRANSITION_MS = 900/);
assert.match(source, /const GALLERY_SEQUENCE: GalleryCategory\[\] = \['Movie', 'Series', 'Anime', 'Movie', 'Series', 'Anime'\]/);
assert.match(source, /gallerySlides\.length === 6/);
assert.match(source, /data-gallery-card/);
assert.match(source, /galleryIndex = nextIndex/);
assert.match(source, /galleryIndex \+ 1\) % gallerySlides\.length/);
assert.match(source, /galleryTransitionTimer = setTimeout/);
assert.match(source, /clearGalleryTimers/);
assert.match(source, /return \(\) => \{/);
assert.match(source, /killTweensOf/);
assert.match(source, /const \{ gsap \} = await import\('gsap'\)/);
assert.match(source, /timeline\.fromTo/);
assert.match(source, /timeline\.to/);

// Full-bleed hero markup contract (replaces the old stacked-poster gallery)
assert.match(source, /class="hero-slide"/);
assert.match(source, /class="hero-stack"/);
assert.match(source, /class="hero-scrim"/);
assert.match(source, /class="hero-copy"/);
assert.match(source, /class="hero-dots"/);
assert.match(source, /class="hero-controls"/);
assert.match(source, /aria-label="Previous title"/);
assert.match(source, /aria-label="Next title"/);
assert.match(source, /aria-roledescription="carousel"/);
assert.match(source, /prefers-reduced-motion: reduce/);

// Old stacked-poster deck implementation must be fully retired
assert.doesNotMatch(source, /fetch\(/);
assert.doesNotMatch(source, /gallery-stack/);
assert.doesNotMatch(source, /hero-poster-stack/);
assert.doesNotMatch(source, /rotation: visibleDepth/);
assert.doesNotMatch(source, /Cormorant Garamond/);
assert.doesNotMatch(source, /DM Mono/);

console.log('Discover hero carousel contract tests passed');
