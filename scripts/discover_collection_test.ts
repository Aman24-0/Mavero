import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const loader = await readFile(new URL('../src/lib/server/content/discover-load.ts', import.meta.url), 'utf8');
const service = await readFile(new URL('../src/lib/server/content/service.ts', import.meta.url), 'utf8');
const collection = await readFile(new URL('../src/lib/components/CollectionPage.svelte', import.meta.url), 'utf8');
const routes = await Promise.all([
  readFile(new URL('../src/routes/discover/movies/+page.server.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/routes/discover/series/+page.server.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/routes/discover/anime/+page.server.ts', import.meta.url), 'utf8')
]);

assert.match(loader, /url\.searchParams\.get\('page'\)/);
assert.match(loader, /collection\(type, page, filters\)/);
assert.match(loader, /hasNextPage: result\.hasNextPage/);
assert.match(loader, /validCollectionSorts/);
assert.match(service, /export async function collection\(type: ContentType, page = 1, filters: CollectionFilters = \{\}\)/);
assert.match(service, /getAniListCollection\(page, filters\)/);
assert.match(service, /getTmdbCollection\(type, page, filters\)/);
for (const route of routes) assert.match(route, /loadCollectionData\('[^']+', url\)/);

assert.match(collection, /export let currentPage = 1/);
assert.match(collection, /export let hasNextPage = false/);
assert.match(collection, /params\.set\('page', String\(Math\.max\(1, targetPage\)\)\)/);
assert.match(collection, /params\.set\('page', '1'\)/);
assert.match(collection, /href=\{collectionHref\(currentPage - 1\)\}/);
assert.match(collection, /href=\{collectionHref\(currentPage \+ 1\)\}/);
assert.doesNotMatch(collection, /filteredItems/);
assert.doesNotMatch(collection, /load-sentinel/);

console.log('Discover collection pagination/filter contract tests passed');
