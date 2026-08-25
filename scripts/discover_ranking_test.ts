import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const service = await readFile(new URL('../src/lib/server/content/service.ts', import.meta.url), 'utf8');
const tmdb = await readFile(new URL('../src/lib/server/content/adapters/tmdb.ts', import.meta.url), 'utf8');
const anilist = await readFile(new URL('../src/lib/server/content/adapters/anilist.ts', import.meta.url), 'utf8');
const discoverLoad = await readFile(new URL('../src/lib/server/content/discover-load.ts', import.meta.url), 'utf8');

assert.match(service, /type RankableMedia/);
assert.match(service, /function audienceConfidence/);
assert.match(service, /item\.rating \/ 10/);
assert.match(service, /boundedLog\(item\.voteCount/);
assert.match(service, /boundedLog\(item\.popularity/);
assert.match(service, /function isUsableItem/);
assert.match(service, /function uniqueUsableItems/);
assert.match(service, /export function selectFeatured/);
assert.match(service, /featuredConfidence/);
assert.match(service, /rankForExposure\(result\.items/);
assert.match(service, /filters\.sort === 'Top rated' \? 'top-rated'/);

assert.match(tmdb, /vote_count\?: number/);
assert.match(tmdb, /popularity\?: number/);
assert.match(tmdb, /function hasRequiredListMetadata/);
assert.match(tmdb, /Boolean\(asString\(raw\.poster_path\) \|\| asString\(raw\.backdrop_path\)\)/);
assert.match(tmdb, /backdrop: image\(raw\.backdrop_path \?\? raw\.poster_path, imageConfig\.backdropSize, imageConfig\)/);
assert.match(tmdb, /backdropSmall: image\(raw\.backdrop_path \?\? raw\.poster_path, 'w780', imageConfig\)/);
assert.match(tmdb, /'vote_count\.gte': 250/);
assert.match(tmdb, /popularity: asNumber\(raw\.popularity\)/);
assert.match(tmdb, /voteCount: asNumber\(raw\.vote_count\)/);

assert.match(anilist, /popularity\?: number \| null/);
assert.match(anilist, /popularity: asNumber\(raw\.popularity\)/);
assert.match(anilist, /media\(type: ANIME/);
assert.match(discoverLoad, /selectFeatured\(\[\.\.\.trendingMovies\.items/);

console.log('Discover recognition-aware ranking contract tests passed');
