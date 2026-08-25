import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTVNavigation } from '../src/lib/tv/navigation';
import { getTVRemoteAction, isBackAction, isNavigationAction } from '../src/lib/tv/remote';
import { pickVerticalCandidate } from '../src/lib/tv/focus';

function keyEvent(key: string, keyCode?: number) {
  return { key, keyCode, preventDefault() {} } as KeyboardEvent & { keyCode?: number };
}

const arrowActions = [
  ['ArrowUp', 'up'],
  ['ArrowDown', 'down'],
  ['ArrowLeft', 'left'],
  ['ArrowRight', 'right'],
  ['Enter', 'enter'],
  ['Escape', 'back']
] as const;

for (const [key, expected] of arrowActions) {
  assert.equal(getTVRemoteAction(keyEvent(key)), expected, `${key} should normalize to ${expected}`);
}

assert.equal(getTVRemoteAction(keyEvent('Back')), 'back');
assert.equal(getTVRemoteAction(keyEvent('', 10009)), 'back');
assert.equal(getTVRemoteAction(keyEvent('MediaPlayPause')), 'playPause');
assert.equal(getTVRemoteAction(keyEvent('Exit')), null, 'dedicated Exit must not be hijacked');
assert.equal(getTVRemoteAction(keyEvent('TVExit')), null, 'dedicated TVExit must not be hijacked');
assert.equal(isNavigationAction('left'), true);
assert.equal(isBackAction('back'), true);

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  right: left + width,
  top,
  bottom: top + height
});
const exitRow = rect(120, 920, 900, 64);
const animeResult = rect(112, 588, 208, 294);
const nearbyCategory = rect(420, 520, 230, 58);
const verticalCandidates = [
  { id: 'anime-result', rect: animeResult },
  { id: 'nearby-category', rect: nearbyCategory }
];
assert.equal(
  pickVerticalCandidate(exitRow, 'up', verticalCandidates, (candidate) => candidate.rect)?.id,
  'anime-result',
  'ArrowUp from the Exit row should choose the nearest preceding result row'
);
assert.equal(
  pickVerticalCandidate(animeResult, 'down', [
    { id: 'exit-row', rect: exitRow },
    { id: 'far-right-control', rect: rect(760, 910, 160, 64) }
  ], (candidate) => candidate.rect)?.id,
  'exit-row',
  'ArrowDown from a result should choose the nearest succeeding row'
);

const navigation = createTVNavigation();
assert.deepEqual(navigation.current, { screen: 'home', focusId: 'tv-nav-home' });
navigation.open('search', 'tv-nav-search');
navigation.open('my-list', 'tv-nav-list');
assert.equal(navigation.depth, 2);
assert.deepEqual(navigation.goBack(), { screen: 'search', focusId: 'tv-nav-search' });
assert.deepEqual(navigation.goBack(), { screen: 'home', focusId: 'tv-nav-home' });
assert.equal(navigation.goBack(), null);
navigation.open('settings', 'tv-nav-settings');
navigation.rememberFocus('tv-section-action');
assert.deepEqual(navigation.current, { screen: 'settings', focusId: 'tv-section-action' });
navigation.reset();
assert.equal(navigation.depth, 0);
assert.deepEqual(navigation.current, { screen: 'home', focusId: 'tv-nav-home' });

const [focusSource, shellSource, routeSource, routeServerSource, mediaRailSource, heroSource, searchSource, detailSource, myListSource, navigationSource, playerSource, performanceSource] = await Promise.all([
  readFile(new URL('../src/lib/tv/focus.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/components/tv/TvShell.svelte', import.meta.url), 'utf8'),
  readFile(new URL('../src/routes/tv/+page.svelte', import.meta.url), 'utf8'),
  readFile(new URL('../src/routes/tv/+page.server.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/components/tv/TvMediaRail.svelte', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/components/tv/TvHero.svelte', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/components/tv/TvSearch.svelte', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/components/tv/TvDetail.svelte', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/components/tv/TvMyList.svelte', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/tv/navigation.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/components/tv/TvPlayer.svelte', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/components/tv/TvPerformance.svelte', import.meta.url), 'utf8')
]);

assert.match(focusSource, /tvFocusGroup/);
assert.match(focusSource, /restoreFirst/);
assert.match(focusSource, /scrollIntoView/);
assert.match(focusSource, /move\(direction: FocusDirection, scope\?: string\)/);
assert.match(focusSource, /pickVerticalCandidate/);
assert.match(focusSource, /VERTICAL_ROW_TOLERANCE/);
assert.match(shellSource, /TvHeader/);
assert.match(shellSource, /TvNav/);
assert.match(shellSource, /TvMediaRail/);
assert.match(shellSource, /TvLoading/);
assert.match(shellSource, /TvHero/);
assert.match(shellSource, /TvError/);
assert.match(shellSource, /asyncState/);
assert.match(shellSource, /tv-retry/);
assert.match(shellSource, /coordinator\.restoreFirst/);
assert.match(shellSource, /data-tv-focus-group="tv-exit"/);
assert.match(shellSource, /isTizenBrewHostedModule/);
assert.match(routeSource, /TvShell/);
assert.match(routeSource, /discover=\{data\}/);
assert.match(routeServerSource, /loadDiscoverData/);
assert.match(mediaRailSource, /MediaItem/);
assert.match(mediaRailSource, /data-tv-focus-group/);
assert.match(mediaRailSource, /display: flex/);
assert.match(mediaRailSource, /flex-wrap: nowrap/);
assert.match(mediaRailSource, /overflow-x: auto/);
assert.doesNotMatch(mediaRailSource, /slice\(0,\s*6\)/, 'TV media rail must not cap recommendations at six items');
assert.match(heroSource, /Featured from Discover/);
assert.match(shellSource, /Phase 4 connects Search data first/);
assert.match(shellSource, /TvSearch/);
assert.match(shellSource, /searchController/);
assert.match(shellSource, /searchRequestSequence/);
assert.match(shellSource, /api\/content\/search/);
assert.match(shellSource, /searchKeyboardOpen/);
assert.match(shellSource, /searchCategory/);
assert.match(searchSource, /TvSearchCategory/);
assert.match(searchSource, /tv-search-keyboard/);
assert.match(searchSource, /tv-search-categories/);
assert.match(searchSource, /tv-search-input/);
assert.match(searchSource, /tv-search-submit/);
assert.match(searchSource, /Back closes/);
assert.match(searchSource, /No matching stories/);
assert.match(searchSource, /--tv-search-category-font/);
assert.match(searchSource, /--tv-search-key-font/);
assert.match(searchSource, /--tv-search-utility-font/);
assert.match(searchSource, /text-overflow: ellipsis/);
assert.match(searchSource, /nativeImeExperiment/);
assert.match(searchSource, /tv-search-native-ime-input/);
assert.match(searchSource, /type="text"/);
assert.match(searchSource, /onchange=/);
assert.match(shellSource, /TvDetail/);
assert.match(shellSource, /TvMyList/);
assert.match(shellSource, /api\/content\/\$\{item\.type\}/);
assert.match(shellSource, /api\/content\/series/);
assert.match(shellSource, /payload\.item\.type === 'series' \|\| payload\.item\.type === 'anime'/, 'TV shell must fetch seasons only for Series and Anime');
assert.match(shellSource, /detailCacheLimit = 4/);
assert.match(shellSource, /while \(detailCache\.size > detailCacheLimit\)/);
assert.match(shellSource, /detailController\?\.abort\(\)/);
assert.match(shellSource, /loadDetailRecommendations/);
assert.match(shellSource, /getLocalFavorites/);
assert.match(shellSource, /setFavoriteStatus/);
assert.match(shellSource, /removeFavoriteFromMyList/);
assert.match(shellSource, /syncAuthenticatedState/);
assert.match(shellSource, /if \(page\.data\.user\)/, 'TV cloud sync must remain authenticated-only');
assert.match(shellSource, /Array\.from\(item\.genres/ , 'TV favorite snapshots must materialize reactive genre arrays');
assert.match(shellSource, /if \(screen === 'my-list'\) void loadMyList\(\)/, 'Returning from detail to My List must refresh local items');
assert.match(shellSource, /details ready/);
assert.match(shellSource, /Player actions remain outside Phase 7/);
assert.match(shellSource, /TvPlayer/);
assert.match(shellSource, /tv-player-remote/);
assert.match(shellSource, /screen === 'player'/);
assert.match(shellSource, /phase7MockPlaybackUrl/);
assert.match(shellSource, /openPlayer/);
assert.match(shellSource, /navigation\.open\('player'/);
assert.match(detailSource, /Seasons and episodes/);
assert.match(detailSource, /item\.type === 'series' \|\| item\.type === 'anime'/, 'Only Series and Anime detail may render the season guide');
assert.doesNotMatch(detailSource, /item\.type !== 'movie'/, 'Movie detail must not use the broad non-movie season-guide gate');
assert.match(detailSource, /tv-detail-my-list/);
assert.match(detailSource, /tv-detail-recommendations/);
assert.match(detailSource, /tv-detail-watch-now/);
assert.match(detailSource, /onWatchNow/);
assert.match(detailSource, /episodeVisibleCount/);
assert.match(detailSource, /slice\(0, episodeVisibleCount\)/);
assert.match(detailSource, /tv-detail-episodes-more/);
assert.match(detailSource, /font-weight: 950/);
assert.match(myListSource, /Local-first/);
assert.match(myListSource, /tv-my-list/);
assert.match(navigationSource, /'detail'/);
assert.match(navigationSource, /'player'/);
assert.match(playerSource, /<video/);
assert.match(playerSource, /preload="metadata"/);
assert.match(playerSource, /onloadedmetadata/);
assert.match(playerSource, /tv-player-toggle/);
assert.match(playerSource, /tv-player-back/);
assert.match(playerSource, /seekBy\(-10\)/);
assert.match(playerSource, /seekBy\(10\)/);
assert.match(playerSource, /tv-player-remote/);
assert.match(playerSource, /No playback source is available/);
assert.match(playerSource, /track kind="captions"/);
assert.doesNotMatch(playerSource, /autoplay/);
assert.doesNotMatch(shellSource, /AVPlay/);
assert.doesNotMatch(shellSource, /supabase/);
assert.match(shellSource, /TvPerformance/);
assert.match(shellSource, /tvPerformanceEnabled/);
assert.match(shellSource, /tvperf/);
assert.match(performanceSource, /mavero-tv-js-loaded/);
assert.match(performanceSource, /mavero-tv-dom-content-loaded/);
assert.match(performanceSource, /mavero-tv-first-paint/);
assert.match(performanceSource, /mavero-tv-first-interactive-paint/);
assert.match(performanceSource, /__MAVERO_TV_PERFORMANCE__/);
assert.match(performanceSource, /setInterval/);
assert.match(performanceSource, /clearInterval/);
assert.match(performanceSource, /samples\.length > 64/);
assert.match(performanceSource, /current\.samples\.shift\(\)/);

console.log('TV contract tests passed: remote, navigation, focus, async states, route isolation, real Discover wiring, Search, Detail, My List, and strict player/auth boundaries.');
