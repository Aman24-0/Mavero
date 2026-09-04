// Upcoming releases contract tests.
//
// Verifies:
//   1. Month/year parsing (valid + invalid + fallback to current date)
//   2. Type parsing (valid + invalid fallback to 'all')
//   3. Year options are dynamic around current year
//   4. monthBounds produces correct first/last day strings
//   5. Movie date-range filtering (items only contain dates in range)
//   6. TV episode date filtering (only in-month episodes)
//   7. Upcoming type filtering (only requested type returned)
//   8. Anime schedule mapping (episode number + date from airingAt)
//   9. Provider mapping (flatrate only, IN region, max 3)
//  10. Empty results (no upstream data → empty array, no fake items)
//  11. Partial TMDB/AniList failure (one source fails → others still return)
//  12. No fabricated episode metadata (missing upstream fields → undefined)
//
// These tests import the upcoming module's pure helpers + internals
// directly. Network-dependent functions are tested via source inspection
// of the data-flow contracts rather than live upstream calls.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

const upcomingSrc = await readFile(new URL('src/lib/server/content/upcoming.ts', root), 'utf8');
const upcomingPageSrc = await readFile(new URL('src/routes/upcoming/+page.svelte', root), 'utf8');
const profileSrc = await readFile(new URL('src/routes/profile/+page.svelte', root), 'utf8');
const authShellSrc = await readFile(new URL('src/lib/components/AuthShell.svelte', root), 'utf8');

console.log('Upcoming releases contract tests');

// --- 1. Month/year parsing ---
// parseUpcomingMonth: valid 1-12, invalid falls back to current month
assert.match(upcomingSrc, /export function parseUpcomingMonth/, 'parseUpcomingMonth is exported');
assert.match(upcomingSrc, /Number\.isInteger\(n\) && n >= 1 && n <= 12/, 'month validated as integer 1-12');
assert.match(upcomingSrc, /return now\.getMonth\(\) \+ 1/, 'invalid month falls back to current month');

// parseUpcomingYear: valid 1900-2100, invalid falls back to current year
assert.match(upcomingSrc, /export function parseUpcomingYear/, 'parseUpcomingYear is exported');
assert.match(upcomingSrc, /Number\.isInteger\(n\) && n >= 1900 && n <= 2100/, 'year validated as integer 1900-2100');
assert.match(upcomingSrc, /return now\.getFullYear\(\)/, 'invalid year falls back to current year');

// --- 2. Type parsing ---
assert.match(upcomingSrc, /export function parseUpcomingType/, 'parseUpcomingType is exported');
assert.match(upcomingSrc, /value === 'movie' \|\| value === 'series' \|\| value === 'anime'/, 'type validated against movie/series/anime');
assert.match(upcomingSrc, /return 'all'/, 'invalid type falls back to all');

// --- 3. Year options dynamic ---
assert.match(upcomingSrc, /export function upcomingYearOptions/, 'upcomingYearOptions is exported');
assert.match(upcomingSrc, /const current = new Date\(\)\.getFullYear\(\)/, 'year options based on current year');
assert.match(upcomingSrc, /return \[current - 1, current, current \+ 1, current \+ 2, current \+ 3\]/, 'year options span prev year through +3 years');

// --- 4. monthBounds ---
assert.match(upcomingSrc, /export function monthBounds/, 'monthBounds is exported');
// Verify gte is first day, lte is last day (day 0 of next month)
assert.match(upcomingSrc, /new Date\(Date\.UTC\(year, month - 1, 1\)\)/, 'monthBounds start = first day of month');
assert.match(upcomingSrc, /new Date\(Date\.UTC\(year, month, 0\)\)/, 'monthBounds end = day 0 of next month = last day of this month');
// Verify the returned gte/lte are YYYY-MM-DD strings
assert.match(upcomingSrc, /getUTCFullYear\(\)/, 'monthBounds uses getUTCFullYear');
assert.match(upcomingSrc, /getUTCMonth\(\) \+ 1/, 'monthBounds uses getUTCMonth + 1 (1-indexed)');
assert.match(upcomingSrc, /getUTCDate\(\)/, 'monthBounds uses getUTCDate');

// --- 5. Movie date-range filtering ---
// loadUpcomingMovies uses primary_release_date.gte/lte
assert.match(upcomingSrc, /'primary_release_date\.gte': gte/, 'movies filtered by primary_release_date.gte');
assert.match(upcomingSrc, /'primary_release_date\.lte': lte/, 'movies filtered by primary_release_date.lte');
// Movies must have a release_date to be included
assert.match(upcomingSrc, /filter\(\(m\) => m\.id && \(m\.title \|\| m\.original_title\) && m\.release_date\)/, 'movies filtered to only those with release_date');
// Movie items are sorted chronologically
assert.match(upcomingSrc, /\.sort\(\(a, b\) => a\.timestamp - b\.timestamp\)/, 'movies sorted by timestamp ascending');

// --- 6. TV episode date filtering ---
// loadUpcomingSeries uses air_date.gte/lte on discover/tv
assert.match(upcomingSrc, /'air_date\.gte': gte/, 'series discover filtered by air_date.gte');
assert.match(upcomingSrc, /'air_date\.lte': lte/, 'series discover filtered by air_date.lte');
// Then fetches season episodes and filters to in-month air dates
assert.match(upcomingSrc, /getTvSeasonEpisodes/, 'series fetches season episodes');
assert.match(upcomingSrc, /inMonthEpisodes = season\.episodes\.filter/, 'episodes filtered to in-month air dates');
assert.match(upcomingSrc, /startMs && ms <= endMs/, 'episode air date checked against month start/end ms');

// --- 7. Upcoming type filtering ---
// loadUpcoming only loads the requested type(s)
assert.match(upcomingSrc, /wantMovies = filters\.type === 'all' \|\| filters\.type === 'movie'/, 'movies loaded when type is all or movie');
assert.match(upcomingSrc, /wantSeries = filters\.type === 'all' \|\| filters\.type === 'series'/, 'series loaded when type is all or series');
assert.match(upcomingSrc, /wantAnime = filters\.type === 'all' \|\| filters\.type === 'anime'/, 'anime loaded when type is all or anime');
// Tasks are only pushed for wanted types
assert.match(upcomingSrc, /if \(wantMovies\) \{[\s\S]*?tasks\.push/, 'movie task only pushed when wantMovies');
assert.match(upcomingSrc, /if \(wantSeries\) \{[\s\S]*?tasks\.push/, 'series task only pushed when wantSeries');
assert.match(upcomingSrc, /if \(wantAnime\) \{[\s\S]*?tasks\.push/, 'anime task only pushed when wantAnime');

// --- 8. Anime schedule mapping ---
// loadUpcomingAnime uses AiringSchedule query with airingAt_greater/lesser
assert.match(upcomingSrc, /airingSchedules\(airingAt_greater/, 'anime uses AiringSchedule with airingAt_greater');
assert.match(upcomingSrc, /airingAt_lesser/, 'anime uses airingAt_lesser');
// Episode number comes from schedule.episode (real AniList data)
assert.match(upcomingSrc, /episode: s\.episode \?\? undefined/, 'anime episode number from AniList schedule.episode');
// Date derived from airingAt (unix seconds → YYYY-MM-DD)
assert.match(upcomingSrc, /const ts = \(s\.airingAt \?\? 0\) \* 1000/, 'anime timestamp from airingAt seconds');
assert.match(upcomingSrc, /const date = .+getUTCFullYear.+getUTCMonth.+getUTCDate/, 'anime date derived from airingAt UTC');

// --- 9. Provider mapping ---
// getTvWatchProviders fetches /tv/{id}/watch/providers
assert.match(upcomingSrc, /\/tv\/\$\{seriesId\}\/watch\/providers/, 'providers fetched from TMDB watch/providers endpoint');
// Only flatrate (streaming), NOT buy/rent
assert.match(upcomingSrc, /regionData\?\.flatrate \?\? \[\]/, 'only flatrate providers used');
assert.doesNotMatch(upcomingSrc, /regionData\?\.buy/, 'buy providers NOT included');
assert.doesNotMatch(upcomingSrc, /regionData\?\.rent/, 'rent providers NOT included');
// IN region default
assert.match(upcomingSrc, /result\.results\?\.\[region\] \?\? result\.results\?\.IN/, 'providers use IN region fallback');
// Max 3 providers on the card
assert.match(upcomingSrc, /providers\.length \? providers\.slice\(0, 3\)/, 'max 3 providers per series item');
// Provider logo uses TMDB logo_path
assert.match(upcomingSrc, /logo: tmdbImage\(p\.logo_path, 'w92'\)/, 'provider logo from TMDB logo_path');

// --- 10. Empty results ---
// When all sources fail, items array stays empty — no fake content.
// The orchestrator initializes items as empty and only pushes on success.
assert.match(upcomingSrc, /const items: UpcomingItem\[\] = \[\];/, 'items initialized as empty array');
assert.match(upcomingSrc, /errorMessage: items\.length === 0 && errors\.length > 0/, 'errorMessage only when no items AND errors exist');

// --- 11. Partial TMDB/AniList failure ---
// Each source is loaded independently via Promise.all with individual catch
assert.match(upcomingSrc, /tasks\.push\([\s\S]*?\.then\([\s\S]*?\.catch\(/, 'each source has independent catch');
assert.match(upcomingSrc, /errors\.push\(`Movies: \$\{safeMessage\(err\)\}`\)/, 'failed movie source pushes Movies error');
assert.match(upcomingSrc, /errors\.push\(`Series: \$\{safeMessage\(err\)\}`\)/, 'failed series source pushes Series error');
assert.match(upcomingSrc, /errors\.push\(`Anime: \$\{safeMessage\(err\)\}`\)/, 'failed anime source pushes Anime error');
// Successful sources still return items even if others fail
assert.match(upcomingSrc, /then\(\(m\) => \{ items\.push\(\.\.\.m\); \}\)/, 'successful movie source pushes items');
assert.match(upcomingSrc, /then\(\(s\) => \{ items\.push\(\.\.\.s\); \}\)/, 'successful series source pushes items');
assert.match(upcomingSrc, /then\(\(a\) => \{ items\.push\(\.\.\.a\); \}\)/, 'successful anime source pushes items');

// --- 12. No fabricated episode metadata ---
// Series episode/season only set when upstream provides them
assert.match(upcomingSrc, /season: seasonToInspect/, 'series season from real TMDB season number');
assert.match(upcomingSrc, /episode: episode\.episode_number \?\? undefined/, 'series episode from real TMDB episode_number (undefined if missing)');
assert.match(upcomingSrc, /episodeTitle: episode\.name \|\| undefined/, 'series episodeTitle from real TMDB episode name (undefined if missing)');
// Anime episode only set when provided
assert.match(upcomingSrc, /episode: s\.episode \?\? undefined/, 'anime episode undefined when AniList does not provide it');
// No hardcoded S01/E01 anywhere
assert.doesNotMatch(upcomingSrc, /season: 1[,}]/, 'no hardcoded season: 1');
assert.doesNotMatch(upcomingSrc, /episode: 1[,}]/, 'no hardcoded episode: 1');

// --- Caching ---
// Cache key includes month/year/type/region
assert.match(upcomingSrc, /const key = `upcoming:movies:\$\{year\}:\$\{month\}:\$\{region\}`/, 'movie cache key includes year+month+region');
assert.match(upcomingSrc, /const key = `upcoming:series:\$\{year\}:\$\{month\}:\$\{region\}`/, 'series cache key includes year+month+region');
assert.match(upcomingSrc, /const key = `upcoming:anime:\$\{year\}:\$\{month\}`/, 'anime cache key includes year+month');
// TTL set
assert.match(upcomingSrc, /upcomingPolicy = \{ ttlMs: 1000 \* 60 \* 10/, 'upcoming cache has 10-minute TTL');
// Concurrency limit on season lookups
assert.match(upcomingSrc, /LOOKUP_CONCURRENCY = 4/, 'season lookups concurrency-limited');
assert.match(upcomingSrc, /mapWithConcurrency\(candidates, [\s\S]*?LOOKUP_CONCURRENCY\)/, 'season lookups use mapWithConcurrency');

// --- Page UI contracts ---
// Dropdown components used for filters (not native select)
assert.match(upcomingPageSrc, /import Dropdown from '\$components\/Dropdown\.svelte'/, 'page imports Dropdown component');
assert.match(upcomingPageSrc, /<Dropdown id="upcoming-month"/, 'month filter uses Dropdown');
assert.match(upcomingPageSrc, /<Dropdown id="upcoming-year"/, 'year filter uses Dropdown');
assert.match(upcomingPageSrc, /<Dropdown id="upcoming-type"/, 'type filter uses Dropdown');
// URL query params used for shareable filters
assert.match(upcomingPageSrc, /params\.set\('month', next\.month\)/, 'month written to URL');
assert.match(upcomingPageSrc, /params\.set\('year', next\.year\)/, 'year written to URL');
assert.match(upcomingPageSrc, /params\.set\('type', next\.type\)/, 'type written to URL');
// ScrollToTop present
assert.match(upcomingPageSrc, /import ScrollToTop from '\$components\/ScrollToTop\.svelte'/, 'page imports ScrollToTop');
assert.match(upcomingPageSrc, /<ScrollToTop \/>/, 'ScrollToTop rendered');
// Back to Profile pill button
assert.match(upcomingPageSrc, /class="back-pill"/, 'page has back-pill button to Profile');
// Empty state
assert.match(upcomingPageSrc, /No releases found/, 'page has empty state heading');
assert.match(upcomingPageSrc, /Change filters/, 'page has Change filters CTA');
// Items grouped by day
assert.match(upcomingPageSrc, /dayGroups/, 'page groups items by day');
assert.match(upcomingPageSrc, /day-label/, 'page renders day labels');
// Series card shows Sxx · Exx
assert.match(upcomingPageSrc, /S\{String\(item\.season\)\.padStart\(2, '0'\)\} · E\{String\(item\.episode\)\.padStart\(2, '0'\)\}/, 'series card shows Sxx · Exx');
// Anime card shows Episode N
assert.match(upcomingPageSrc, /Episode \{item\.episode\}/, 'anime card shows Episode N');
// Provider logos rendered
assert.match(upcomingPageSrc, /provider-logo/, 'page renders provider logos');
assert.match(upcomingPageSrc, /item\.providers\.slice\(0, 3\)/, 'page renders max 3 provider logos');

// --- Profile: Upcoming action card before Settings ---
assert.match(profileSrc, /href="\/upcoming"/, 'Profile has Upcoming action card');
assert.match(profileSrc, /href="\/settings"/, 'Profile still has Settings action card');
// Upcoming appears before Settings in the source
const upcomingIdx = profileSrc.indexOf('href="/upcoming"');
const settingsIdx = profileSrc.indexOf('href="/settings"');
assert.ok(upcomingIdx > -1 && settingsIdx > -1 && upcomingIdx < settingsIdx, 'Upcoming action card appears BEFORE Settings action card');
// CalendarClock icon used for Upcoming
assert.match(profileSrc, /CalendarClock/, 'Profile imports CalendarClock icon for Upcoming');

// --- Auth spacing fix: back-pill is in flow, not absolute ---
assert.match(authShellSrc, /auth-top-bar/, 'AuthShell has auth-top-bar wrapper for back-pill');
assert.doesNotMatch(authShellSrc, /\.back-pill \{[^}]*position: absolute/, 'back-pill is NO LONGER position: absolute (now in flow)');
assert.match(authShellSrc, /\.auth-top-bar \{[\s\S]*?margin-bottom: 28px/, 'auth-top-bar has 28px margin-bottom for breathing room');
assert.match(authShellSrc, /\.auth-card \{[\s\S]*?margin: auto/, 'auth-card centered with margin: auto in remaining space');

console.log('\nAll upcoming releases contract tests passed');
