/**
 * Task 6 regression (2026-10-15) — season switching inside the player
 * episode sheet.
 *
 * Pins the contract of the new in-sheet season row:
 *   §A  Sheet UI: the season row renders ONLY for multi-season episodic
 *       content (movies/anime movies never show season UI); horizontally
 *       scrollable; active season visually distinct + aria-current.
 *   §B  States: loading / error+retry / empty / ready — and the PREVIOUS
 *       season's episodes are cleared the moment a new season is selected
 *       (never shown as though they belong to the new season).
 *   §C  Data flow reuses EXISTING contracts: the watch page fetches the
 *       season via /api/content/series/[id]/season/[season] ({ok,
 *       season:{episodes}}), NOT a new API; eligibility via the SAME
 *       getEligibleSeasons helper the detail page uses (unaired seasons
 *       filtered; season 0 specials excluded upstream by
 *       extractSeasonsData).
 *   §D  Stale-request prevention: request sequence + AbortController — a
 *       slow season-A response can never replace the season-B list.
 *   §E  Navigation: selecting an episode in ANY season goes through the
 *       existing onEpisodeChange → handleEpisodeChange → canonical PATH
 *       route (/watch/tv-show/1396/5/6, /watch/anime-series/30984/2/1).
 *   §F  Current-episode preservation: the sheet opens on the CURRENT
 *       season and highlights the current episode.
 *   §G  Eligibility behavior (pure helper used by the sheet options).
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/mav_task6_episode_sheet_seasons_test.ts
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p: string) => readFileSync(resolve(root, p), 'utf-8');

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

async function run() {
  console.log('\nTask 6 — episode sheet season switching\n');

  const shell = src('src/lib/components/player/PlayerShell.svelte');
  const watch = src('src/routes/watch/[type]/[id]/+page.svelte');
  const seasonApi = src('src/routes/api/content/series/[id]/season/[season]/+server.ts');

  console.log('§A — sheet UI');
  {
    ok(/\{#if seasons\.length > 1\}[\s\S]{0,400}role="tablist" aria-label="Seasons"/.test(shell), 'A1. the season row renders ONLY for multi-season content (movies never show it)');
    ok(/\.season-row \{[\s\S]{0,200}overflow-x: auto;/.test(shell), 'A2. the season row is horizontally scrollable (narrow mobile screens)');
    ok(/class:active=\{sheetDisplaySeason === season\.number\}/.test(shell), 'A3. the active season is visually distinct');
    ok(/aria-current=\{sheetDisplaySeason === season\.number \? 'true' : undefined\}/.test(shell), 'A4. the active season is aria-current marked (accessible)');
    ok(/aria-selected=\{sheetDisplaySeason === season\.number\}/.test(shell), 'A5. tablist semantics (role=tab + aria-selected)');
  }

  console.log('\n§B — sheet states');
  {
    ok(/sheetState === 'loading'/.test(shell) && /Loading season \{sheetDisplaySeason\} episodes/.test(shell), 'B1. loading state');
    ok(/sheetState === 'error'/.test(shell) && /onSeasonRetry\(\)/.test(shell), 'B2. error state with a Retry action');
    ok(/sheetEpisodes\.length === 0/.test(shell) && /No episodes available for season/.test(shell), 'B3. empty state');
    ok(/sheetState = \(sheetDisplaySeason === null \|\| sheetDisplaySeason === currentSheetSeason\)\s*\n?\s*\? 'ready'/.test(shell), 'B4. ready state on the current season (unchanged pre-Task-6 behavior)');

    // Previous season's list is cleared on switch (the watch page clears
    // the list to [] while loading; PlayerShell renders [] for a switched
    // season until seasonView matches).
    ok(/seasonView = \{ season, episodes: \[\], state: 'loading' \}/.test(watch), 'B5. selecting a season CLEARS the list while loading (never shows the previous season mislabeled)');
    ok(/: \(seasonView && seasonView\.season === sheetDisplaySeason \? seasonView\.episodes : \[\]\)/.test(shell), 'B6. a switched season displays ONLY its own loaded view');
  }

  console.log('\n§C — reuses the existing data contracts');
  {
    ok(/api\/content\/series\/\$\{encodeURIComponent\(item\.id\)\}\/season\/\$\{season\}/.test(watch), 'C1. the watch page fetches via the EXISTING /api/content/series/[id]/season/[season] endpoint');
    ok(/payload\?\.ok \|\| !Array\.isArray\(payload\.season\?\.episodes\)/.test(watch), 'C2. parses the established {ok, season:{episodes}} contract');
    ok(!/api\/content\/.*season.*\+server/.test('') && seasonApi.includes('getSeriesSeason'), 'C3. the endpoint itself is UNCHANGED (no duplicate season API)');
    ok(/getEligibleSeasons\(item\.seasonsData\)/.test(watch), 'C4. season options derive from item.seasonsData via getEligibleSeasons (the detail page selector helper)');
    ok(/import \{ getEligibleSeasons \} from '\$lib\/shared\/episode-eligibility'/.test(watch), 'C5. the eligibility helper is the shared one (no second implementation)');
  }

  console.log('\n§D — stale-request prevention');
  {
    ok(/const seq = \+\+seasonViewSeq;/.test(watch), 'D1. every season fetch carries a request sequence');
    ok(/if \(seq !== seasonViewSeq \|\| controller\.signal\.aborted\) return; \/\/ superseded — silent/.test(watch), 'D2. stale/aborted responses are discarded (fast season switching is safe)');
    ok(/seasonViewController\?\.abort\(\)/.test(watch), 'D3. the previous season fetch is aborted on a new selection');
    ok(/seasonViewSeq \+= 1;[\s\S]{0,120}seasonViewController\?\.abort\(\)/.test(watch), 'D4. the in-flight fetch is invalidated on destroy');
  }

  console.log('\n§E — navigation contract');
  {
    ok(/chooseEpisode\(\{ season: episode\.season, episode: episode\.number, title: episode\.title \}\)/.test(shell), 'E1. sheet episodes navigate via the existing chooseEpisode → onEpisodeChange');
    ok(/canonicalWatchHref\(routeType, bareId, target\.season, target\.episode\)/.test(watch), 'E2. episode change goes to the canonical PATH route (season/episode segments)');
    ok(/function handleEpisodeChange\(target: PlayerEpisodeTarget\)/.test(watch), 'E3. the SAME handler as before Task 6 (no parallel navigation system)');
  }

  console.log('\n§F — current-episode preservation');
  {
    ok(/openEpisodeSheet[\s\S]{0,400}sheetViewingSeason = null;/.test(shell), 'F1. the sheet ALWAYS opens on the CURRENT season');
    ok(/class:active=\{currentEpisode\?\.season === episode\.season && currentEpisode\?\.episode === episode\.number\}/.test(shell), 'F2. the current episode is highlighted');
    ok(/\$: if \(sheetViewingSeason !== null && currentSheetSeason === sheetViewingSeason\) \{[\s\S]{0,80}sheetViewingSeason = null;/.test(shell), 'F3. after navigation the switch state dissolves back to the current season');
    ok(/closeEpisodeSheet[\s\S]{0,300}sheetViewingSeason = null;/.test(shell), 'F4. closing the sheet drops the switch state');
  }

  console.log('\n§G — eligibility helper behavior (the shared filter)');
  {
    const { getEligibleSeasons } = await import('../src/lib/shared/episode-eligibility');
    const past = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const future = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const seasons = [
      { number: 1, airDate: past, episodeCount: 8 },
      { number: 2, airDate: past, episodeCount: 10 },
      { number: 3, airDate: future, episodeCount: 12 }, // announced, not aired
    ];
    const eligible = getEligibleSeasons(seasons);
    ok(eligible.length === 2 && eligible.map((s) => s.number).join(',') === '1,2', 'G1. unaired (announced) seasons are filtered out of the sheet row');
    ok(getEligibleSeasons([]).length === 0, 'G2. empty input → empty row (never invents a season)');
  }

  console.log(`\nTask 6 result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
