import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const service = await readFile(new URL('../src/lib/server/content/service.ts', import.meta.url), 'utf8');
const tmdb = await readFile(new URL('../src/lib/server/content/adapters/tmdb.ts', import.meta.url), 'utf8');
const anilist = await readFile(new URL('../src/lib/server/content/adapters/anilist.ts', import.meta.url), 'utf8');

assert.match(service, /function audienceConfidence\(item: NormalizedMediaItem\)/);
assert.match(service, /item\.rating \/ 10/);
assert.match(service, /boundedLog\(item\.voteCount/);
assert.match(service, /boundedLog\(item\.popularity/);
assert.match(service, /rankForExposure\(result\.items/);
assert.match(service, /filters\.sort === 'Top rated' \? 'top-rated'/);
assert.match(tmdb, /vote_count\?: number/);
assert.match(tmdb, /popularity\?: number/);
assert.match(tmdb, /'vote_count\.gte': 250/);
assert.match(tmdb, /popularity: asNumber\(raw\.popularity\)/);
assert.match(tmdb, /voteCount: asNumber\(raw\.vote_count\)/);
assert.match(anilist, /popularity\?: number \| null/);
assert.match(anilist, /popularity: asNumber\(raw\.popularity\)/);
assert.match(anilist, /media\(type: ANIME/);

console.log('Discover recognition-aware ranking contract tests passed');
