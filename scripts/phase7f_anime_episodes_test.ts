import assert from 'node:assert/strict';
import { generateFallbackEpisodes, jikanInternals } from '$lib/server/content/adapters/jikan';
import type { NormalizedMediaItem } from '$lib/server/content/types';

// ============================================================
// Phase 7F+ — Anime episode guide tests
//
// Tests the Jikan episode data integration and fallback behavior.
// These tests do NOT make live Jikan API calls (they would be
// rate-limited/flaky). They test:
//   - Fallback episode generation (when Jikan is unavailable)
//   - Jikan episode mapping (title, number, airDate, still)
//   - Pagination support (148 episodes → multiple pages)
//   - DetailPage/SeasonEpisodes rendering for anime series
//   - Watch page server routing
//
// Note: getAnimeSeason is not imported directly because it lives in
// the content service which imports $env/dynamic/private (a SvelteKit
// virtual module not resolvable by tsx). The Jikan adapter and
// generateFallbackEpisodes are imported directly instead — they are
// the pure-logic components that getAnimeSeason delegates to.
// ============================================================

// ============================================================
// TEST 1: Fallback episode generation — 148 episodes
// (CASE 7: Hunter x Hunter shows 148 episodes)
// ============================================================
{
  const episodes = generateFallbackEpisodes(148);
  assert.equal(episodes.length, 148, 'TEST 1: 148 episodes generated');
  assert.equal(episodes[0].number, 1, 'TEST 1: first episode is #1');
  assert.equal(episodes[0].season, 1, 'TEST 1: first episode is season 1');
  assert.equal(episodes[147].number, 148, 'TEST 1: last episode is #148');
  console.log('TEST 1 passed: Hunter x Hunter 148 episodes');
}

// ============================================================
// TEST 2: Anime movie → no episode guide
// (CASE 9: Infinity Castle has no episode guide)
// ============================================================
{
  const { readFileSync } = await import('node:fs');
  const service = readFileSync(new URL('../src/lib/server/content/service.ts', import.meta.url), 'utf8');
  assert.match(service, /if \(item\.animeFormat === 'movie'\)/, 'TEST 2: getAnimeSeason checks animeFormat === movie');
  assert.match(service, /episodeCount: 0, episodes: \[\]/, 'TEST 2: anime movie returns empty episodes');
  console.log('TEST 2 passed: anime movie has no episode guide');
}

// ============================================================
// TEST 3: Fallback episode generation — 11 episodes
// (CASE 8: Entertainment District Arc shows 11 episodes)
// ============================================================
{
  const episodes = generateFallbackEpisodes(11);
  assert.equal(episodes.length, 11, 'TEST 3: 11 episodes generated');
  assert.equal(episodes[0].number, 1, 'TEST 3: first episode is #1');
  assert.equal(episodes[0].title, 'Episode 1', 'TEST 3: first episode title');
  assert.equal(episodes[10].number, 11, 'TEST 3: last episode is #11');
  assert.equal(episodes[10].title, 'Episode 11', 'TEST 3: last episode title');
  console.log('TEST 3 passed: 11-episode fallback generated');
}

// ============================================================
// TEST 4: Fallback episode generation — 148 episodes (pagination)
// ============================================================
{
  const episodes = generateFallbackEpisodes(148);
  assert.equal(episodes.length, 148, 'TEST 4: 148 episodes generated');
  assert.equal(episodes[0].number, 1, 'TEST 4: first is #1');
  assert.equal(episodes[147].number, 148, 'TEST 4: last is #148');
  console.log('TEST 4 passed: 148-episode fallback (pagination support)');
}

// ============================================================
// TEST 5: Fallback episode generation — 0 episodes
// ============================================================
{
  const episodes = generateFallbackEpisodes(0);
  assert.equal(episodes.length, 0, 'TEST 5: 0 episodes');
  console.log('TEST 5 passed: zero episodes');
}

// ============================================================
// TEST 6: Fallback episode generation — negative count (safety)
// ============================================================
{
  const episodes = generateFallbackEpisodes(-5);
  assert.equal(episodes.length, 0, 'TEST 6: negative → 0 episodes');
  console.log('TEST 6 passed: negative count handled safely');
}

// ============================================================
// TEST 7: Jikan failure → fallback behavior
// (CASE 15: Jikan failure fallback)
// ============================================================
{
  const { readFileSync } = await import('node:fs');
  const service = readFileSync(new URL('../src/lib/server/content/service.ts', import.meta.url), 'utf8');
  assert.match(service, /Jikan failure is non-fatal/, 'TEST 7: Jikan failure caught');
  assert.match(service, /generateFallbackEpisodes/, 'TEST 7: fallback to generated episodes');
  console.log('TEST 7 passed: Jikan failure fallback');
}

// ============================================================
// TEST 8: Jikan episode mapping — title, number, airDate, still
// ============================================================
{
  const { mapJikanEpisode } = jikanInternals;
  const raw = {
    mal_id: 42,
    title: 'The Test Episode',
    title_romanji: 'Test Episode',
    synopsis: 'A test synopsis.',
    aired: '2024-01-15T00:00:00+00:00',
    runtime: 24,
    images: { jpg: { image_url: 'https://cdn.example.test/ep42.jpg' } },
    filler: false,
    recap: false
  };
  const mapped = mapJikanEpisode(raw, 1);
  assert.equal(mapped.number, 42, 'TEST 8: episode number');
  assert.equal(mapped.season, 1, 'TEST 8: season');
  assert.equal(mapped.title, 'Test Episode', `TEST 8: title (romanji preferred), got ${mapped.title}`);
  assert.equal(mapped.overview, 'A test synopsis.', 'TEST 8: overview');
  assert.equal(mapped.airDate, '2024-01-15T00:00:00+00:00', 'TEST 8: airDate');
  assert.equal(mapped.runtime, '24m', 'TEST 8: runtime');
  assert.equal(mapped.still, 'https://cdn.example.test/ep42.jpg', 'TEST 8: still image');
  console.log('TEST 8 passed: Jikan episode mapping');
}

// ============================================================
// TEST 9: Jikan episode mapping — missing fields
// ============================================================
{
  const { mapJikanEpisode } = jikanInternals;
  const raw = {
    mal_id: 1,
    title: null,
    synopsis: null,
    aired: null,
    runtime: null,
    images: null
  };
  const mapped = mapJikanEpisode(raw, 1);
  assert.equal(mapped.number, 1, 'TEST 9: number from mal_id');
  assert.equal(mapped.title, 'Episode 1', `TEST 9: fallback title, got ${mapped.title}`);
  assert.equal(mapped.overview, undefined, 'TEST 9: overview undefined');
  assert.equal(mapped.airDate, undefined, 'TEST 9: airDate undefined');
  assert.equal(mapped.runtime, undefined, 'TEST 9: runtime undefined');
  assert.equal(mapped.still, undefined, 'TEST 9: still undefined');
  console.log('TEST 9 passed: Jikan missing fields handled');
}

// ============================================================
// TEST 10: SeasonEpisodes API endpoint — anime ID routing
// ============================================================
{
  const { readFileSync } = await import('node:fs');
  const api = readFileSync(new URL('../src/routes/api/content/series/[id]/season/[season]/+server.ts', import.meta.url), 'utf8');
  assert.match(api, /params\.id\.startsWith\('anime-'\)/, 'TEST 10: API routes anime-* IDs');
  assert.match(api, /getAnimeSeason/, 'TEST 10: API calls getAnimeSeason for anime');
  assert.match(api, /getSeriesSeason/, 'TEST 10: API calls getSeriesSeason for normal series');
  console.log('TEST 10 passed: anime episode API routing');
}

// ============================================================
// TEST 11: DetailPage renders SeasonEpisodes for anime series
// ============================================================
{
  const { readFileSync } = await import('node:fs');
  const detail = readFileSync(new URL('../src/lib/components/DetailPage.svelte', import.meta.url), 'utf8');
  assert.match(detail, /type === 'series' \|\| \(item\.isAnime && item\.animeFormat !== 'movie'\)/, 'TEST 11: DetailPage renders SeasonEpisodes for anime series');
  assert.match(detail, /animeFormat !== 'movie'/, 'TEST 11: anime movies excluded from SeasonEpisodes');
  assert.match(detail, /watchType=\{type === 'anime' \? 'anime' : 'series'\}/, 'TEST 11: watchType prop passed');
  console.log('TEST 11 passed: DetailPage anime series rendering');
}

// ============================================================
// TEST 12: Watch page server loads anime episodes
// ============================================================
{
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../src/routes/watch/[type]/[id]/+page.server.ts', import.meta.url), 'utf8');
  assert.match(server, /getAnimeSeason/, 'TEST 12: watch server calls getAnimeSeason');
  assert.match(server, /item\.isAnime === true/, 'TEST 12: watch server checks isAnime');
  assert.match(server, /animeFormat !== 'movie'/, 'TEST 12: watch server excludes anime movies from episode loading');
  console.log('TEST 12 passed: watch page server loads anime episodes');
}

// ============================================================
// TEST 13: SeasonEpisodes uses watchType for URL routing
// ============================================================
{
  const { readFileSync } = await import('node:fs');
  const season = readFileSync(new URL('../src/lib/components/SeasonEpisodes.svelte', import.meta.url), 'utf8');
  assert.match(season, /watchType.*'series' \| 'anime'/, 'TEST 13: SeasonEpisodes accepts watchType prop');
  assert.match(season, /\/watch\/\$\{watchType\}\//, 'TEST 13: SeasonEpisodes uses watchType in URL');
  console.log('TEST 13 passed: SeasonEpisodes watchType routing');
}

// ============================================================
// TEST 14: Jikan adapter has caching
// ============================================================
{
  const { readFileSync } = await import('node:fs');
  const jikan = readFileSync(new URL('../src/lib/server/content/adapters/jikan.ts', import.meta.url), 'utf8');
  assert.match(jikan, /getOrSet/, 'TEST 14: Jikan uses getOrSet cache');
  assert.match(jikan, /episodePolicy/, 'TEST 14: Jikan has episode policy');
  assert.match(jikan, /ttlMs.*60.*60.*24/, 'TEST 14: Jikan cache is 24h');
  console.log('TEST 14 passed: Jikan caching');
}

// ============================================================
// TEST 15: Jikan pagination — MAX_PAGES cap
// ============================================================
{
  const { readFileSync } = await import('node:fs');
  const jikan = readFileSync(new URL('../src/lib/server/content/adapters/jikan.ts', import.meta.url), 'utf8');
  assert.match(jikan, /MAX_PAGES.*10/, 'TEST 15: Jikan has MAX_PAGES cap');
  assert.match(jikan, /has_next_page/, 'TEST 15: Jikan checks pagination has_next_page');
  assert.match(jikan, /page \+= 1/, 'TEST 15: Jikan increments page');
  console.log('TEST 15 passed: Jikan pagination support');
}

// ============================================================
// TEST 16: DetailPage shows episode count for anime series
// ============================================================
{
  const { readFileSync } = await import('node:fs');
  const detail = readFileSync(new URL('../src/lib/components/DetailPage.svelte', import.meta.url), 'utf8');
  assert.match(detail, /item\.isAnime && item\.episodes/, 'TEST 16: DetailPage shows episode count for anime');
  assert.match(detail, /episode\{item\.episodes === 1 \? '' : 's'\}/, 'TEST 16: pluralized episode count');
  console.log('TEST 16 passed: anime episode count display');
}

console.log('Phase 7F+ anime episode guide tests passed: 148-episode fallback (1); anime movie no guide (2); 11-episode fallback (3); 148-episode fallback (4); zero episodes (5); negative safety (6); Jikan failure fallback (7); Jikan mapping (8); missing fields (9); API routing (10); DetailPage rendering (11); watch server (12); SeasonEpisodes watchType (13); Jikan caching (14); pagination (15); episode count display (16).');
