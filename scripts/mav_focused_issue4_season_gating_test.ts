/**
 * MAV-FOCUSED Issue 4 (2026-10) — season tab + episode action gating
 * integration regression suite.
 *
 * Tests the WIRING between the TMDB adapter, the presenter, the
 * DetailPage and the SeasonEpisodes component — that the eligibility
 * helpers from `$lib/shared/episode-eligibility.ts` are correctly
 * PLUMBED through the existing pipeline:
 *
 *   - The TMDB adapter captures `seasonsData` from the TMDB TV detail
 *     response (number + airDate + episodeCount + poster per season).
 *   - The presenter forwards `seasonsData` to the client-side MediaItem.
 *   - The MediaItem type carries the new `seasonsData?: Season[]` field.
 *   - DetailPage passes `seasonsData` to SeasonEpisodes.
 *   - SeasonEpisodes uses `getEligibleSeasons` to filter the season tabs
 *     (announced / unstarted seasons are hidden).
 *   - SeasonEpisodes uses `isEpisodeReleased` to gate Play/Download per
 *     episode (future-dated episodes render an "Upcoming" badge instead).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf-8');
/** Source with line comments stripped — assertions must never match prose. */
const readCode = (p: string) => read(p)
  .split('\n')
  .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
  .join('\n');

let passed = 0;
let failed = 0;
function ok(condition: unknown, label: string) {
  if (condition) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

console.log('\n1 — TMDB adapter: seasonsData capture');
{
  const adapter = readCode('src/lib/server/content/adapters/tmdb.ts');
  ok(/function extractSeasonsData\(raw: TmdbTv\): Season\[\] \| undefined/.test(adapter), '1a. extractSeasonsData helper exists');
  ok(/season_number/.test(adapter) && /air_date/.test(adapter) && /episode_count/.test(adapter), '1b. extractSeasonsData reads season_number + air_date + episode_count from the raw TMDB season');
  ok(/seasonNumber <= 0\) continue/.test(adapter), '1c. Season 0 (Specials) is skipped (never a tab)');
  ok(/seasonsData = isMovie \? undefined : extractSeasonsData\(tv\)/.test(adapter), '1d. mapTmdb populates seasonsData for TV/anime-series items');
  ok(/seasonsData,/.test(adapter), '1e. seasonsData is included in the returned NormalizedMediaItem');
}

console.log('\n2 — presenter: seasonsData forwarded to the client MediaItem');
{
  const presenter = readCode('src/lib/server/content/presenter.ts');
  ok(/seasonsData: item\.seasonsData/.test(presenter), '2a. toMediaItem forwards seasonsData to the client-side MediaItem');
}

console.log('\n3 — client MediaItem type: seasonsData field exists');
{
  const data = readCode('src/lib/data/content.ts');
  ok(/seasonsData\?: Season\[\]/.test(data), '3a. the MediaItem type declares seasonsData?: Season[]');
  ok(/export type Season = \{/.test(data), '3b. the Season type is exported (mirrors the server-side type)');
  ok(/export type Episode = \{/.test(data), '3c. the Episode type is exported (mirrors the server-side type)');
  ok(/airDate\?: string;/.test(data), '3d. Episode carries an airDate?: string field');
}

console.log('\n4 — DetailPage: seasonsData passed to SeasonEpisodes');
{
  const detail = readCode('src/lib/components/DetailPage.svelte');
  ok(/seasonsData=\{item\.seasonsData\}/.test(detail), '4a. DetailPage passes item.seasonsData to SeasonEpisodes');
}

console.log('\n5 — SeasonEpisodes: season tabs use the eligibility-filtered list');
{
  const component = readCode('src/lib/components/SeasonEpisodes.svelte');
  ok(/export let seasonsData: Season\[\] \| undefined = undefined/.test(component), '5a. SeasonEpisodes declares the seasonsData prop');
  ok(/import \{ isEpisodeReleased, getEligibleSeasons, type EligibleSeason \} from '\$lib\/shared\/episode-eligibility'/.test(component), '5b. SeasonEpisodes imports the eligibility helpers');
  // The eligibility-filtered season list (replaces the previous count-based loop).
  ok(/eligibleSeasonNumbers = \(\(\) => \{/.test(component), '5c. an eligibleSeasonNumbers reactive declaration exists');
  ok(/getEligibleSeasons\(seasonsData as EligibleSeason\[\]\)/.test(component), '5d. getEligibleSeasons is called on the seasonsData prop');
  // The season tabs render from eligibleSeasonNumbers, NOT from Array(seasonCount).
  ok(/\{#each eligibleSeasonNumbers as seasonNumber\}/.test(component), '5e. season tabs iterate eligibleSeasonNumbers (NOT the previous Array(seasonCount))');
  ok(!/\{#each Array\(Math\.max\(seasonCount, 1\)\) as _, index\}/.test(component), '5f. the previous Array(seasonCount) loop is GONE');
  // Fallback when seasonsData is absent — preserves backward compatibility.
  ok(/Array\.from\(\{ length: Math\.max\(seasonCount, 1\) \}, \(_, i\) => i \+ 1\)/.test(component), '5g. the count-based fallback is retained for callers without seasonsData (backward compatible)');
}

console.log('\n6 — SeasonEpisodes: per-episode Play/Download gating');
{
  const component = readCode('src/lib/components/SeasonEpisodes.svelte');
  ok(/function episodeIsReleased\(episode: Episode\): boolean \{/.test(component), '6a. an episodeIsReleased wrapper exists');
  ok(/isEpisodeReleased\(episode, \{ hasConfirmedPlayableSource: true \}\)/.test(component), '6b. episodeIsReleased delegates to isEpisodeReleased with the trusted-availability fallback');
  // The Play/Download buttons are wrapped in {#if episodeIsReleased(episode)}.
  ok(/\{#if episodeIsReleased\(episode\)\}/.test(component), '6c. Play/Download are gated on episodeIsReleased');
  // The {:else} branch renders an Upcoming badge (no placeholder action buttons).
  ok(/\{:else\}/.test(component) && /ep-upcoming-badge/.test(component), '6d. the else branch renders an "Upcoming" badge (no actionable control)');
  ok(/Upcoming/.test(component), '6e. the Upcoming badge label is rendered');
  // The episode row itself is still rendered (so the user sees what's coming).
  // Verify that the episode's title + airDate still render in the row.
  const rowStart = component.indexOf('{#each season.episodes as episode}');
  const rowEnd = component.indexOf('{/each}', rowStart);
  const rowBody = component.slice(rowStart, rowEnd);
  ok(/episode\.title/.test(rowBody), '6f. the episode row still renders the title (visible even for future episodes)');
  ok(/episode\.airDate/.test(rowBody), '6g. the episode row still renders the airDate (visible even for future episodes)');
}

console.log('\n7 — SeasonEpisodes: default selected season is the latest eligible');
{
  const component = readCode('src/lib/components/SeasonEpisodes.svelte');
  // The previous behavior always loaded S1. The new behavior loads the
  // LATEST eligible season (so a currently-airing show opens on the
  // current season, not S1).
  ok(/const initialSeason = \(eligibleSeasonNumbers\.length > 0\)/.test(component), '7a. the initialSeason is computed from eligibleSeasonNumbers');
  ok(/eligibleSeasonNumbers\[eligibleSeasonNumbers\.length - 1\]/.test(component), '7b. the initialSeason picks the LAST (latest) eligible season number');
}

console.log('\n8 — no hardcoded Black Clover / The Gentlemen exceptions');
{
  // The fix must be the SHARED eligibility logic, not a hardcoded exception
  // for specific titles. Assert no title-string checks are introduced.
  const component = readCode('src/lib/components/SeasonEpisodes.svelte');
  ok(!/black[\s-]?clover/i.test(component), '8a. no Black Clover-specific hardcoding in SeasonEpisodes');
  ok(!/gentlemen/i.test(component), '8b. no The Gentlemen-specific hardcoding in SeasonEpisodes');
  const helper = readCode('src/lib/shared/episode-eligibility.ts');
  ok(!/black[\s-]?clover/i.test(helper), '8c. no Black Clover-specific hardcoding in the eligibility helper');
  ok(!/gentlemen/i.test(helper), '8d. no The Gentlemen-specific hardcoding in the eligibility helper');
}

console.log('\n9 — seasonsData does not crash when TMDB omits seasons[] (list responses, fixtures)');
{
  // extractSeasonsData returns undefined when raw.seasons is missing or empty.
  const adapter = readCode('src/lib/server/content/adapters/tmdb.ts');
  ok(/if \(!Array\.isArray\(raw\.seasons\) \|\| raw\.seasons\.length === 0\) return undefined/.test(adapter), '9a. extractSeasonsData returns undefined when seasons[] is missing/empty');
  // The mapTmdb function only calls extractSeasonsData for non-movie types
  // (movies have no seasons).
  ok(/seasonsData = isMovie \? undefined : extractSeasonsData\(tv\)/.test(adapter), '9b. seasonsData is undefined for movies (no array access)');
  // SeasonEpisodes handles the undefined case (falls back to count-based).
  const component = readCode('src/lib/components/SeasonEpisodes.svelte');
  ok(/if \(seasonsData && seasonsData\.length > 0\)/.test(component), '9c. SeasonEpisodes checks seasonsData truthiness before using it');
}

console.log(`\nmav_focused_issue4_season_gating_test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
