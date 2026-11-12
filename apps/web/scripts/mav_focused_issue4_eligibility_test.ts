/**
 * MAV-FOCUSED Issue 4 (2026-10) — episode + season eligibility regression suite.
 *
 * Tests the PURE eligibility helpers in `$lib/shared/episode-eligibility.ts`
 * against the regression cases enumerated in Issue 4's spec:
 *
 *   1. Released episode with a valid release date.
 *   2. Future-dated episode.
 *   3. Episode with missing/invalid release date and no confirmed playable source.
 *   4. Released episode in a currently airing season.
 *   5. Announced future season with no episodes.
 *   6. Season with placeholder episode objects only.
 *   7. Older completed season.
 *   8. Timezone / date-boundary behavior.
 *   9. A partially released season: already released episodes retain valid
 *      actions while future episodes do not.
 *
 * The helpers are PURE — they take (episode|season, options) and return a
 * boolean. We inject `now` so the tests are deterministic and never depend
 * on the wall clock.
 */

import assert from 'node:assert/strict';
import { isEpisodeReleased, isSeasonStarted, getEligibleSeasons, getLatestStartedSeasonNumber } from '$lib/shared/episode-eligibility';

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

// Anchor "now" at 2026-10-13T12:00:00Z (the current date in the user's
// timezone). All test cases compare against THIS instant — never the wall
// clock — so the suite is deterministic across runs and timezones.
const NOW = new Date('2026-10-13T12:00:00.000Z');

console.log('\n1 — released episode with a valid release date');
{
  const episode = { id: 'ep-1', number: 1, season: 1, airDate: '2026-10-10' };
  ok(isEpisodeReleased(episode, { now: NOW }) === true, '1a. an episode that aired 3 days ago is RELEASED');
  const episode2 = { id: 'ep-2', number: 2, season: 1, airDate: '2026-10-13' };
  ok(isEpisodeReleased(episode2, { now: NOW }) === true, '1b. an episode that airs TODAY (UTC midnight has passed) is RELEASED');
}

console.log('\n2 — future-dated episode');
{
  const episode = { id: 'ep-future', number: 3, season: 1, airDate: '2026-10-17' };
  ok(isEpisodeReleased(episode, { now: NOW }) === false, '2a. an episode that airs in 4 days is NOT RELEASED');
  const episode2 = { id: 'ep-future-2', number: 4, season: 1, airDate: '2027-01-01' };
  ok(isEpisodeReleased(episode2, { now: NOW }) === false, '2b. an episode that airs next year is NOT RELEASED');
}

console.log('\n3 — episode with missing/invalid release date and no confirmed playable source');
{
  // Missing airDate, no confirmed playable source → NOT released (we do
  // not invent eligibility).
  const episode1 = { id: 'ep-missing', number: 1, season: 1 /* no airDate */ };
  ok(isEpisodeReleased(episode1, { now: NOW }) === false, '3a. missing airDate + no confirmed source → NOT RELEASED (conservative)');
  ok(isEpisodeReleased(episode1, { now: NOW, hasConfirmedPlayableSource: false }) === false, '3b. missing airDate + hasConfirmedPlayableSource: false → NOT RELEASED');
  // Invalid airDate (not YYYY-MM-DD) → NOT released when no source.
  const episode2 = { id: 'ep-bad', number: 2, season: 1, airDate: 'not-a-date' };
  ok(isEpisodeReleased(episode2, { now: NOW }) === false, '3c. invalid airDate + no confirmed source → NOT RELEASED');
  // Partial date → NOT released.
  const episode3 = { id: 'ep-partial', number: 3, season: 1, airDate: '2026-10' };
  ok(isEpisodeReleased(episode3, { now: NOW }) === false, '3d. partial airDate + no confirmed source → NOT RELEASED');
  // Same decision when hasConfirmedPlayableSource is undefined (the
  // default — preserves the existing trusted-availability fallback for
  // real catalog episodes that have a real source but no air_date).
  ok(isEpisodeReleased(episode1, { now: NOW, hasConfirmedPlayableSource: true }) === true, '3e. missing airDate + hasConfirmedPlayableSource: true → RELEASED (the trusted-availability fallback — a real catalog episode with a real source stays playable)');
}

console.log('\n4 — released episode in a currently airing season');
{
  // Currently-airing season: S2 has 5 aired episodes + 1 future episode.
  const season = {
    number: 2,
    title: 'Season 2',
    episodeCount: 6,
    airDate: '2026-09-01',
    episodes: [
      { id: 'ep-1', number: 1, season: 2, airDate: '2026-09-01' },
      { id: 'ep-2', number: 2, season: 2, airDate: '2026-09-08' },
      { id: 'ep-3', number: 3, season: 2, airDate: '2026-09-15' },
      { id: 'ep-4', number: 4, season: 2, airDate: '2026-09-22' },
      { id: 'ep-5', number: 5, season: 2, airDate: '2026-09-29' },
      { id: 'ep-6', number: 6, season: 2, airDate: '2026-10-20' }, // future
    ],
  };
  ok(isSeasonStarted(season, { now: NOW }) === true, '4a. the currently-airing season is STARTED (at least one episode has aired)');
  for (let i = 0; i < 5; i += 1) {
    ok(isEpisodeReleased(season.episodes![i], { now: NOW }) === true, `4b${i}. episode ${i + 1} (aired) is RELEASED`);
  }
  ok(isEpisodeReleased(season.episodes![5], { now: NOW }) === false, '4c. episode 6 (future-dated) is NOT RELEASED');
}

console.log('\n5 — announced future season with no episodes');
{
  // The Gentlemen S3 case: announced but no episodes, future airDate.
  const season = {
    number: 3,
    title: 'Season 3',
    episodeCount: 0,
    airDate: '2027-01-01', // future airDate
    episodes: [],
  };
  ok(isSeasonStarted(season, { now: NOW }) === false, '5a. a season with no episodes and a future airDate is NOT STARTED');
  // Same season but with past airDate AND no episodes — also not started
  // (we don't trust a season-level date alone when there are no episodes).
  const season2 = { ...season, airDate: '2026-01-01' };
  ok(isSeasonStarted(season2, { now: NOW }) === false, '5b. a season with NO episodes (even with a past airDate) is NOT STARTED — episodeCount=0 means no real metadata');
  // With episodes: episodeCount > 0, past airDate, but all episodes have future dates → still started (season airDate + episodeCount).
  const season3 = { ...season, episodeCount: 8, airDate: '2026-01-01', episodes: [] };
  ok(isSeasonStarted(season3, { now: NOW }) === true, '5c. a season with episodeCount > 0, past airDate, and an empty episodes array (episodes not yet loaded) IS STARTED');
}

console.log('\n6 — season with placeholder episode objects only');
{
  // All episodes have placeholder shapes: no airDate (or future airDate).
  // The Black Clover S2 case: announced episodes with future dates.
  const season = {
    number: 2,
    title: 'Season 2',
    episodeCount: 12,
    airDate: '2026-10-01',
    episodes: [
      { id: 'ph-1', number: 1, season: 2, airDate: '2026-10-17' }, // future
      { id: 'ph-2', number: 2, season: 2, airDate: '2026-10-24' }, // future
      { id: 'ph-3', number: 3, season: 2, airDate: '2026-10-31' }, // future
    ],
  };
  // The season has episodeCount=12 and a past season airDate — but every
  // episode has a FUTURE airDate. Per the helper's contract, the season
  // is STARTED (season-level metadata says it started) BUT every
  // individual episode is NOT released (Play/Download hidden).
  ok(isSeasonStarted(season, { now: NOW }) === true, '6a. a season with episodeCount > 0 and a past season airDate IS STARTED (the season tab can show)');
  for (let i = 0; i < 3; i += 1) {
    ok(isEpisodeReleased(season.episodes![i], { now: NOW }) === false, `6b${i}. placeholder episode ${i + 1} (future-dated) is NOT RELEASED — Play/Download are hidden`);
  }
}

console.log('\n7 — older completed season');
{
  // Black Clover S1 (or any older completed season): all episodes aired
  // years ago. The season should be started AND every episode released.
  const season = {
    number: 1,
    title: 'Season 1',
    episodeCount: 10,
    airDate: '2017-10-03',
    episodes: [
      { id: 'old-1', number: 1, season: 1, airDate: '2017-10-03' },
      { id: 'old-2', number: 2, season: 1, airDate: '2017-10-10' },
      { id: 'old-3', number: 3, season: 1, airDate: '2017-10-17' },
    ],
  };
  ok(isSeasonStarted(season, { now: NOW }) === true, '7a. an older completed season is STARTED');
  for (let i = 0; i < 3; i += 1) {
    ok(isEpisodeReleased(season.episodes![i], { now: NOW }) === true, `7b${i}. older episode ${i + 1} is RELEASED`);
  }
}

console.log('\n8 — timezone / date-boundary behavior');
{
  // The bug: a date-only release value should not become "released"
  // prematurely because of an accidental timezone conversion. We treat
  // every date-only value as MIDNIGHT UTC. An IST user at
  // 2026-10-13T05:30 IST (which is 2026-10-13T00:00 UTC) sees the
  // 2026-10-13 release as just-aired. An IST user at 2026-10-13T04:00
  // IST (2026-10-12T22:30 UTC) sees it as not-yet-released.
  const episode = { id: 'ep-tz', number: 1, season: 1, airDate: '2026-10-13' };

  // 2026-10-13T00:00:00.000Z — exactly midnight UTC. Released.
  ok(isEpisodeReleased(episode, { now: new Date('2026-10-13T00:00:00.000Z') }) === true, '8a. episode with airDate 2026-10-13 is RELEASED at exactly midnight UTC');
  // 2026-10-12T23:59:59.999Z — one millisecond before midnight UTC. Not released.
  ok(isEpisodeReleased(episode, { now: new Date('2026-10-12T23:59:59.999Z') }) === false, '8b. episode with airDate 2026-10-13 is NOT RELEASED one millisecond before midnight UTC (no premature timezone-conversion release)');
  // 2026-10-13T05:30:00.000Z — well into the day. Released.
  ok(isEpisodeReleased(episode, { now: new Date('2026-10-13T05:30:00.000Z') }) === true, '8c. episode with airDate 2026-10-13 is RELEASED at 05:30 UTC (the same day)');
  // 2026-10-14T00:00:00.000Z — the day after. Released.
  ok(isEpisodeReleased(episode, { now: new Date('2026-10-14T00:00:00.000Z') }) === true, '8d. episode with airDate 2026-10-13 is RELEASED on 2026-10-14');
}

console.log('\n9 — partially released season: aired episodes keep actions, future ones do not');
{
  // Black Clover S2 (the actual issue scenario): S2 has 2 aired episodes
  // + episode 3 with airDate 2026-10-17 (future). Episodes 1 and 2 must
  // keep Play/Download; episode 3 must NOT.
  const season = {
    number: 2,
    title: 'Season 2',
    episodeCount: 12,
    airDate: '2026-10-01',
    episodes: [
      { id: 'bc-s2e1', number: 1, season: 2, airDate: '2026-10-03' }, // aired
      { id: 'bc-s2e2', number: 2, season: 2, airDate: '2026-10-10' }, // aired
      { id: 'bc-s2e3', number: 3, season: 2, airDate: '2026-10-17' }, // future
    ],
  };
  ok(isSeasonStarted(season, { now: NOW }) === true, '9a. S2 is STARTED (has aired episodes)');
  ok(isEpisodeReleased(season.episodes![0], { now: NOW }) === true, '9b. S2E1 (aired 2026-10-03) is RELEASED — Play/Download remain');
  ok(isEpisodeReleased(season.episodes![1], { now: NOW }) === true, '9c. S2E2 (aired 2026-10-10) is RELEASED — Play/Download remain');
  ok(isEpisodeReleased(season.episodes![2], { now: NOW }) === false, '9d. S2E3 (airs 2026-10-17) is NOT RELEASED — Play/Download are HIDDEN');
}

console.log('\n10 — getEligibleSeasons + getLatestStartedSeasonNumber');
{
  // A show with 3 seasons: S1 (aired), S2 (currently airing), S3 (announced, future).
  const seasons = [
    { number: 1, title: 'Season 1', episodeCount: 10, airDate: '2017-10-03', episodes: [{ id: 's1e1', number: 1, season: 1, airDate: '2017-10-03' }] },
    { number: 2, title: 'Season 2', episodeCount: 12, airDate: '2026-10-01', episodes: [{ id: 's2e1', number: 1, season: 2, airDate: '2026-10-03' }] },
    { number: 3, title: 'Season 3', episodeCount: 0, airDate: '2027-01-01', episodes: [] }, // announced, future
  ];
  const eligible = getEligibleSeasons(seasons, { now: NOW });
  ok(eligible.length === 2, `10a. exactly 2 seasons are eligible (S1 + S2; S3 is filtered out) — got ${eligible.length}`);
  ok(eligible.map((s) => s.number).join(',') === '1,2', `10b. eligible season numbers are [1, 2] in original order — got [${eligible.map((s) => s.number).join(',')}]`);
  ok(getLatestStartedSeasonNumber(seasons, { now: NOW }) === 2, '10c. the latest started season number is 2 (S3 is NOT the latest started)');

  // Empty / null input.
  ok(getEligibleSeasons([], { now: NOW }).length === 0, '10d. empty input → empty result');
  ok(getEligibleSeasons(undefined, { now: NOW }).length === 0, '10e. undefined input → empty result');
  ok(getEligibleSeasons(null, { now: NOW }).length === 0, '10f. null input → empty result');
  ok(getLatestStartedSeasonNumber([], { now: NOW }) === 0, '10g. empty input → latest started season = 0');
}

console.log('\n11 — date parser validation (edge cases that must NOT be treated as released)');
{
  // Invalid dates that the regex would catch:
  ok(isEpisodeReleased({ id: 'ep', number: 1, season: 1, airDate: '2026-13-01' }, { now: NOW, hasConfirmedPlayableSource: false }) === false, '11a. month 13 is invalid → NOT RELEASED');
  ok(isEpisodeReleased({ id: 'ep', number: 1, season: 1, airDate: '2026-00-01' }, { now: NOW, hasConfirmedPlayableSource: false }) === false, '11b. month 0 is invalid → NOT RELEASED');
  ok(isEpisodeReleased({ id: 'ep', number: 1, season: 1, airDate: '2026-10-32' }, { now: NOW, hasConfirmedPlayableSource: false }) === false, '11c. day 32 is invalid → NOT RELEASED');
  ok(isEpisodeReleased({ id: 'ep', number: 1, season: 1, airDate: '2026-02-30' }, { now: NOW, hasConfirmedPlayableSource: false }) === false, '11d. Feb 30 is invalid (Date.UTC rolls over) → NOT RELEASED');
  ok(isEpisodeReleased({ id: 'ep', number: 1, season: 1, airDate: '' }, { now: NOW, hasConfirmedPlayableSource: false }) === false, '11e. empty string airDate → NOT RELEASED');
  ok(isEpisodeReleased({ id: 'ep', number: 1, season: 1, airDate: '   ' }, { now: NOW, hasConfirmedPlayableSource: false }) === false, '11f. whitespace-only airDate → NOT RELEASED');
}

console.log('\n12 — determinism: helpers are pure (same input → same output)');
{
  const episode = { id: 'ep-1', number: 1, season: 1, airDate: '2026-10-10' };
  const r1 = isEpisodeReleased(episode, { now: NOW });
  const r2 = isEpisodeReleased(episode, { now: NOW });
  ok(r1 === r2, '12a. isEpisodeReleased returns the same result for the same input');
  // No side effects on the input.
  ok(episode.airDate === '2026-10-10', '12b. the input episode is NOT mutated');
}

console.log(`\nmav_focused_issue4_eligibility_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
