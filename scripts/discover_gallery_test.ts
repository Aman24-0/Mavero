import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/lib/components/DiscoverPage.svelte', import.meta.url), 'utf8');

assert.match(source, /const GALLERY_ROTATION_MS = 5000/);
assert.match(source, /const GALLERY_TRANSITION_MS = 960/);
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
assert.match(source, /timeline\.to/);
assert.match(source, /class:outgoing/);
assert.match(source, /gallery-card-title/);
assert.match(source, /gallery-card-actions/);
assert.match(source, /gallery-controls/);
assert.match(source, /gallery-dots/);
assert.match(source, /aria-label="Previous title"/);
assert.match(source, /aria-label="Next title"/);
assert.match(source, /prefers-reduced-motion: reduce/);
assert.match(source, /@media \(min-width: 701px\)/);
assert.match(source, /rotation: visibleDepth === 0 \? 0 : \(visibleDepth % 2 \? 0\.32 : -0\.24\)/);
assert.match(source, /\.gallery-stack \{ width: min\(100%, 1080px\); aspect-ratio: 1\.72;/);
assert.match(source, /@media \(max-width: 700px\)[\s\S]*?\.gallery-stack \{ width: min\(84vw, 340px\); \}/);
assert.doesNotMatch(source, /fetch\(/);
assert.doesNotMatch(source, /gallery-pagination/);
assert.doesNotMatch(source, /gallery-fallback/);
assert.doesNotMatch(source, /class="gallery-copy"/);

console.log('Discover Trending Gallery contract tests passed');
