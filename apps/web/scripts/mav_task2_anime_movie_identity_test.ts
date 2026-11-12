/**
 * Task 2 regression (2026-10-15) — anime-MOVIE identity preservation
 * everywhere (the exact "Demon Slayer: Infinity Castle" scenario).
 *
 * Reported production failure: Infinity Castle (TMDB movie 1311031,
 * anime-classified) is playable from Search as an anime movie, but in
 * Continue Watching and My List it is reclassified as an anime SERIES —
 * the UI adds season/episode labels, generates /anime-series/1311031,
 * and the page 404s ("Title not found").
 *
 * Proven root-cause chain (see worklog):
 *   RC-a  mergeFavorites re-keyed MOVIE-family favorites to contentType
 *         'anime' (hybrid {contentType:'anime', contentId:'movie-*'}).
 *   RC-b  snapshotFromJson dropped isAnime/animeFormat on every cloud
 *         read, so the hybrid lost animeFormat='movie' after one sync.
 *   → presenter legacy fallback ('anime' contentType → series) rendered
 *     /anime-series/1311031 + synthetic S1E1 → 404.
 *
 * This suite pins every boundary:
 *   §A  Cloud round-trip preserves the discriminator (records.ts row mappers)
 *   §B  mergeFavorites never re-keys the movie family to 'anime'
 *   §C  Poisoned legacy records are HEALED to the canonical movie identity
 *   §D  Continue Watching renders the canonical /watch/anime-movie/ URL
 *   §E  My List renders the canonical /anime-movie/ detail URL
 *   §F  Legacy rows WITHOUT the discriminator keep their historical
 *       identity (conservative — never guessed from genres)
 *   §G  Anime-series / TV-series / normal-movie regressions
 *   §H  Movie progress never gains synthetic season/episode
 *   §I  Corrupt flag payloads are rejected by the record validators
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/mav_task2_anime_movie_identity_test.ts
 */

import { mergeFavorites, mergeFavoritesWithProgress, continueWatchingRecords, mergeProgress } from '../src/lib/shared/progress-merge';
import { progressToMedia, favoriteToMedia } from '../src/lib/client/progress/presenter';
import { isPlaybackRecord, isFavoriteRecord, type FavoriteRecord, type WatchProgressRecord } from '../src/lib/client/progress/types';
import { detailHref as detailPath, watchHref as watchPath } from '../src/lib/shared/routes';

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

const INFINITY_CASTLE_SNAPSHOT = {
  title: 'Demon Slayer: Kimetsu no Yaiba — Infinity Castle',
  poster: '/infinity-castle.jpg',
  backdrop: '/infinity-castle-bd.jpg',
  year: 2025,
  runtime: '2h 35m',
  rating: 8.4,
  genres: ['Animation', 'Action'],
  description: 'The Demon Slayer Corps descends into Infinity Castle.',
  isAnime: true,
  animeFormat: 'movie' as const,
};

function movieProgressRecord(overrides: Partial<WatchProgressRecord> = {}): WatchProgressRecord {
  return {
    key: 'movie:movie-1311031:-:-',
    contentType: 'movie',
    contentId: 'movie-1311031',
    season: undefined,
    episode: undefined,
    currentTime: 600,
    duration: 9300,
    completionState: 'in_progress',
    snapshot: { ...INFINITY_CASTLE_SNAPSHOT },
    lastWatchedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    positionUpdatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function movieFavoriteRecord(overrides: Partial<FavoriteRecord> = {}): FavoriteRecord {
  return {
    key: 'movie:movie-1311031',
    contentType: 'movie',
    contentId: 'movie-1311031',
    snapshot: { ...INFINITY_CASTLE_SNAPSHOT },
    status: 'watching',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function run() {
  console.log('\nTask 2 — anime-movie identity preservation (Infinity Castle)\n');

  // ------------------------------------------------------------------
  // §A — cloud round-trip: the row mappers must preserve the flags.
  // (records.ts snapshotFromJson previously stripped both fields.)
  // ------------------------------------------------------------------
  console.log('§A — cloud round-trip preserves the anime discriminator');
  {
    const { progressFromRow, progressToRow, favoriteFromRow, favoriteToRow } = await import('../src/lib/server/supabase/records');
    const record = movieProgressRecord();
    const row = progressToRow('user-redacted', record) as unknown as Record<string, unknown>;
    const roundTripped = progressFromRow(row as never);
    ok(roundTripped.snapshot.isAnime === true, 'A1. progress row round-trip keeps snapshot.isAnime=true');
    ok(roundTripped.snapshot.animeFormat === 'movie', 'A2. progress row round-trip keeps snapshot.animeFormat="movie"');
    ok(isPlaybackRecord(roundTripped), 'A3. round-tripped record still passes isPlaybackRecord');

    const fav = movieFavoriteRecord();
    const favRow = favoriteToRow('user-redacted', fav) as unknown as Record<string, unknown>;
    const favRoundTripped = favoriteFromRow(favRow as never);
    ok(favRoundTripped.snapshot.isAnime === true && favRoundTripped.snapshot.animeFormat === 'movie', 'A4. favorite row round-trip keeps both flags');

    // The presenter output AFTER the round-trip must still be /anime-movie/.
    const item = progressToMedia(roundTripped);
    ok(item.resumeHref === '/watch/anime-movie/1311031', 'A5. post-round-trip resume URL is /watch/anime-movie/1311031');
    ok(detailPath(item.id, item.type, item.isAnime, item.animeFormat) === '/anime-movie/1311031', 'A6. post-round-trip detail URL is /anime-movie/1311031');
  }

  // ------------------------------------------------------------------
  // §B — mergeFavorites: the movie family is NEVER re-keyed to 'anime'.
  // ------------------------------------------------------------------
  console.log('\n§B — mergeFavorites keeps the movie family movie');
  {
    const merged = mergeFavorites([movieFavoriteRecord()], []);
    ok(merged.length === 1, 'B1. one record out');
    ok(merged[0].contentType === 'movie', 'B2. contentType stays "movie" (RC-a fixed: no re-key to "anime")');
    ok(merged[0].key === 'movie:movie-1311031', 'B3. key stays the movie identity key');
    ok(merged[0].snapshot.isAnime === true && merged[0].snapshot.animeFormat === 'movie', 'B4. snapshot flags intact');

    // The dual-surface convergence (legacy 'series' flag records for the
    // SAME movie id would be a data corruption — they group by prefix into
    // the movie family and converge on ONE identity).
    const poisoned = movieFavoriteRecord({ key: 'anime:movie-1311031', contentType: 'anime', updatedAt: 1_700_000_100_000 });
    const healed = mergeFavorites([poisoned], []);
    ok(healed.length === 1, 'B5. poisoned {contentType:"anime", contentId:"movie-*"} record still yields ONE entry');
    ok(healed[0].contentType === 'movie' && healed[0].key === 'movie:movie-1311031', 'B6. poisoned record healed to the canonical movie identity');
    ok(healed[0].snapshot.animeFormat === 'movie', 'B7. healed record carries animeFormat="movie" (even if its snapshot had lost the flag)');
  }

  // ------------------------------------------------------------------
  // §C — the EXACT reported scenario end-to-end: re-keyed record +
  // flag-stripping round-trip + merge + presenters.
  // ------------------------------------------------------------------
  console.log('\n§C — exact reported scenario (re-key + flag loss + merge)');
  {
    // Step 1: the OLD bug produced this poisoned cloud row (hybrid).
    const { progressFromRow, progressToRow, favoriteFromRow, favoriteToRow } = await import('../src/lib/server/supabase/records');
    const poisonedFavorite: FavoriteRecord = {
      key: 'anime:movie-1311031',
      contentType: 'anime',
      contentId: 'movie-1311031',
      snapshot: { ...INFINITY_CASTLE_SNAPSHOT, isAnime: undefined, animeFormat: undefined }, // flags stripped by the OLD snapshotFromJson
      status: 'watching',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
    };
    const row = favoriteToRow('user-redacted', poisonedFavorite) as unknown as Record<string, unknown>;
    const fromCloud = favoriteFromRow(row as never);
    // With the fixed reader the flags stay absent (they were never stored)
    // — the merge must still heal the identity.
    const merged = mergeFavorites([fromCloud], []);
    ok(merged[0].contentType === 'movie', 'C1. poisoned + flag-less favorite heals to contentType "movie"');
    const item = favoriteToMedia(merged[0], []);
    ok(item.type === 'movie' && item.isAnime === true && item.animeFormat === 'movie', 'C2. My List item metadata = anime movie');
    ok(detailPath(item.id, item.type, item.isAnime, item.animeFormat) === '/anime-movie/1311031', 'C3. My List renders /anime-movie/1311031 (never /anime-series/)');
    ok(item.resumeHref === undefined || item.resumeHref === '/watch/anime-movie/1311031', 'C4. resume URL (when present) is /watch/anime-movie/1311031');

    // Progress path of the same scenario.
    const poisonedProgress: WatchProgressRecord = {
      key: 'anime:movie-1311031:1:1',
      contentType: 'anime',
      contentId: 'movie-1311031',
      season: 1, episode: 1, // the phantom episode the old bug fabricated
      currentTime: 300, duration: 9300,
      completionState: 'in_progress',
      snapshot: { ...INFINITY_CASTLE_SNAPSHOT, isAnime: undefined, animeFormat: undefined },
      lastWatchedAt: 1_700_000_050_000, updatedAt: 1_700_000_050_000, positionUpdatedAt: 1_700_000_050_000,
    };
    const cw = continueWatchingRecords([poisonedProgress], []);
    ok(cw.length === 1, 'C5. poisoned progress yields ONE Continue Watching entry');
    const cwItem = progressToMedia(cw[0]);
    ok(cwItem.type === 'movie' && cwItem.animeFormat === 'movie', 'C6. CW display identity = anime movie');
    ok(cwItem.resumeHref === '/watch/anime-movie/1311031', 'C7. CW resume URL is /watch/anime-movie/1311031 — never rewritten to /anime-series/');
  }

  // ------------------------------------------------------------------
  // §D — legacy rows WITHOUT the discriminator keep historical identity.
  // ------------------------------------------------------------------
  console.log('\n§D — legacy compatibility rules (conservative, deterministic)');
  {
    // A movie record without flags: renders as a normal movie (historical
    // identity — the code never guesses anime from genre names).
    const legacyMovie = movieProgressRecord({ snapshot: { title: 'Some Movie', poster: '/x.jpg', genres: ['Animation'] } });
    const item = progressToMedia(legacyMovie);
    ok(item.type === 'movie' && item.isAnime === false && item.animeFormat === undefined, 'D1. flag-less movie record keeps its historical (non-anime) identity');
    ok(item.resumeHref === '/watch/movie/1311031', 'D2. flag-less movie record renders /watch/movie/1311031');

    // A legacy 'anime'-contentType record with a SERIES id: anime series.
    const legacyAnimeSeries: WatchProgressRecord = {
      key: 'anime:series-30984:2:1', contentType: 'anime', contentId: 'series-30984',
      season: 2, episode: 1, currentTime: 100, duration: 1400, completionState: 'in_progress',
      snapshot: { title: 'Attack on Titan', poster: '/aot.jpg' },
      lastWatchedAt: 1, updatedAt: 1, positionUpdatedAt: 1,
    };
    const aotItem = progressToMedia(legacyAnimeSeries);
    ok(aotItem.type === 'anime' && aotItem.animeFormat === 'series', 'D3. legacy "anime" contentType record = anime series');
    ok(aotItem.resumeHref === '/watch/anime-series/30984/2/1', 'D4. legacy anime-series record renders /watch/anime-series/30984/2/1');
  }

  // ------------------------------------------------------------------
  // §E — representative anime-series + TV + movie regressions.
  // ------------------------------------------------------------------
  console.log('\n§E — series/movie regressions');
  {
    const animeSeriesFav: FavoriteRecord = {
      key: 'anime:series-30984', contentType: 'anime', contentId: 'series-30984',
      snapshot: { title: 'Attack on Titan', poster: '/aot.jpg', isAnime: true, animeFormat: 'series' },
      status: 'watching', createdAt: 1, updatedAt: 1,
    };
    const merged = mergeFavorites([animeSeriesFav], []);
    const item = favoriteToMedia(merged[0], [ ]);
    ok(detailPath(item.id, item.type, item.isAnime, item.animeFormat) === '/anime-series/30984', 'E1. anime-series favorite renders /anime-series/30984');

    const mergedWithProgress = mergeFavoritesWithProgress([animeSeriesFav], [legacyAnimeSeriesFromE()], []);
    ok(mergedWithProgress.length === 1 && mergedWithProgress[0].status === 'watching', 'E2. anime-series progress promotes the favorite to "watching"');

    const tvSeriesRecord: WatchProgressRecord = {
      key: 'series:series-1396:5:6', contentType: 'series', contentId: 'series-1396',
      season: 5, episode: 6, currentTime: 900, duration: 2600, completionState: 'in_progress',
      snapshot: { title: 'Breaking Bad', poster: '/bb.jpg' },
      lastWatchedAt: 2, updatedAt: 2, positionUpdatedAt: 2,
    };
    const tvItem = progressToMedia(tvSeriesRecord);
    ok(tvItem.resumeHref === '/watch/tv-show/1396/5/6', 'E3. TV-series progress renders /watch/tv-show/1396/5/6');

    const movieRecord = movieProgressRecord();
    const movieItem = progressToMedia(movieRecord);
    ok(movieItem.resumeHref === '/watch/anime-movie/1311031', 'E4. anime-movie progress renders /watch/anime-movie/1311031');
  }

  // ------------------------------------------------------------------
  // §F/H — movies never gain synthetic season/episode.
  // ------------------------------------------------------------------
  console.log('\n§F/H — no synthetic season/episode for movies');
  {
    const cw = continueWatchingRecords([movieProgressRecord()], []);
    ok(cw.length === 1, 'F1. anime-movie progress → ONE CW entry');
    ok(cw[0].season === undefined && cw[0].episode === undefined, 'F2. CW record carries NO synthetic season/episode');
    ok(cw[0].contentType === 'movie', 'F3. CW record contentType stays "movie"');

    // A "watching" MOVIE favorite with no progress synthesizes a
    // ZERO-progress CW entry (pre-existing intended behavior for the
    // "watching" status) — it must carry NO synthetic season/episode and
    // keep the anime-movie identity.
    const cwFromFav = continueWatchingRecords([], [movieFavoriteRecord()]);
    ok(cwFromFav.length === 1, 'F4. movie "watching" favorite with zero progress yields ONE CW entry (baseline behavior)');
    ok(cwFromFav[0]?.season === undefined && cwFromFav[0]?.episode === undefined, 'F4b. the synthetic movie entry carries NO season/episode');
    ok(progressToMedia(cwFromFav[0]).resumeHref === '/watch/anime-movie/1311031', 'F4c. the synthetic movie entry keeps the /watch/anime-movie/ identity');

    // A SERIES "watching" favorite with no progress still synthesizes S1E1.
    const seriesFav: FavoriteRecord = {
      key: 'series:series-1396', contentType: 'series', contentId: 'series-1396',
      snapshot: { title: 'Breaking Bad', poster: '/bb.jpg' },
      status: 'watching', createdAt: 1, updatedAt: 1,
    };
    const cwSeries = continueWatchingRecords([], [seriesFav]);
    ok(cwSeries.length === 1 && cwSeries[0].season === 1 && cwSeries[0].episode === 1, 'F5. series "watching" favorite still synthesizes S1E1');
  }

  // ------------------------------------------------------------------
  // §G — mergeProgress / dedupe sanity for mixed legacy identities.
  // ------------------------------------------------------------------
  console.log('\n§G — mixed legacy identities converge on one CW entry');
  {
    // A poisoned legacy progress record + the current clean record for the
    // same movie must produce ONE entry (movie family), not two.
    const poisoned: WatchProgressRecord = {
      key: 'anime:movie-1311031:1:1', contentType: 'anime', contentId: 'movie-1311031',
      season: 1, episode: 1, currentTime: 100, duration: 9300, completionState: 'in_progress',
      snapshot: { ...INFINITY_CASTLE_SNAPSHOT, isAnime: undefined, animeFormat: undefined },
      lastWatchedAt: 1_000, updatedAt: 1_000, positionUpdatedAt: 1_000,
    };
    const clean = movieProgressRecord({ lastWatchedAt: 2_000, updatedAt: 2_000, positionUpdatedAt: 2_000 });
    const mergedRecords = mergeProgress([poisoned], [clean]);
    ok(mergedRecords.length === 2, 'G1. both raw records coexist (distinct progress keys — no data loss)');
    const cw = continueWatchingRecords(mergedRecords, []);
    ok(cw.length === 1, 'G2. Continue Watching collapses them into ONE family entry');
    const item = progressToMedia(cw[0]);
    ok(item.resumeHref === '/watch/anime-movie/1311031', 'G3. the entry renders the canonical anime-movie URL');
  }

  // ------------------------------------------------------------------
  // §I — corrupt flag payloads are rejected by the validators.
  // ------------------------------------------------------------------
  console.log('\n§I — record validators reject corrupt flags');
  {
    ok(!isPlaybackRecord({ ...movieProgressRecord(), snapshot: { ...INFINITY_CASTLE_SNAPSHOT, animeFormat: 'ova' } }), 'I1. animeFormat="ova" rejected by isPlaybackRecord');
    ok(!isFavoriteRecord({ ...movieFavoriteRecord(), snapshot: { ...INFINITY_CASTLE_SNAPSHOT, isAnime: 'yes' } }), 'I2. isAnime="yes" rejected by isFavoriteRecord');
    ok(isPlaybackRecord(movieProgressRecord()), 'I3. valid flags still accepted');
    const legacyNoFlags = movieProgressRecord({ snapshot: { title: 'X', poster: '/x.jpg' } });
    ok(isPlaybackRecord(legacyNoFlags), 'I4. records WITHOUT flags still accepted (backward compatible)');
  }

  console.log(`\nTask 2 result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

function legacyAnimeSeriesFromE(): WatchProgressRecord {
  return {
    key: 'anime:series-30984:2:1', contentType: 'anime', contentId: 'series-30984',
    season: 2, episode: 1, currentTime: 100, duration: 1400, completionState: 'in_progress',
    snapshot: { title: 'Attack on Titan', poster: '/aot.jpg' },
    lastWatchedAt: 1, updatedAt: 1, positionUpdatedAt: 1,
  };
}

void run();
