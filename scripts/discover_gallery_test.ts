import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/lib/components/DiscoverPage.svelte', import.meta.url), 'utf8');

assert.match(source, /const GALLERY_ROTATION_MS = 3000/);
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
assert.match(source, /prefers-reduced-motion: reduce/);
assert.doesNotMatch(source, /fetch\(/);
assert.doesNotMatch(source, /gallery-pagination/);
assert.doesNotMatch(source, /gallery-fallback/);
assert.doesNotMatch(source, /class="gallery-copy"/);

console.log('Discover Trending Gallery contract tests passed');
