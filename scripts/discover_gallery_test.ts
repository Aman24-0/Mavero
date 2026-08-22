import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/lib/components/DiscoverPage.svelte', import.meta.url), 'utf8');

assert.match(source, /const GALLERY_ROTATION_MS = 3000/);
assert.match(source, /const sequence: GalleryCategory\[\] = \['Movie', 'Series', 'Anime', 'Movie', 'Series', 'Anime'\]/);
assert.match(source, /gallerySlides\.length === 6/);
assert.match(source, /clearGalleryTimers/);
assert.match(source, /return clearGalleryTimers/);
assert.match(source, /galleryIndex = \(galleryIndex \+ 1\) % gallerySlides\.length/);
assert.match(source, /setTimeout\(\(\) => \{/);
assert.match(source, /const \{ gsap \} = await import\('gsap'\)/);
assert.doesNotMatch(source, /fetch\(/);
assert.match(source, /prefers-reduced-motion: reduce/);
assert.match(source, /class:outgoing/);
assert.match(source, /departingGalleryIndex/);
assert.match(source, /transition: transform 720ms/);
assert.match(source, /galleryAnimating = true/);

console.log('Discover Trending Gallery contract tests passed');
