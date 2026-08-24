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

const [focusSource, shellSource, routeSource, routeServerSource, mediaRailSource, heroSource, searchSource, detailSource, myListSource, navigationSource] = await Promise.all([
  readFile(new URL('../src/lib/tv/focus.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/components/tv/TvShell.svelte', import.meta.url), 'utf8'),
  readFile(new URL('../src/routes/tv/+page.svelte', import.meta.url), 'utf8'),
  readFile(new URL('../src/routes/tv/+page.server.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/components/tv/TvMediaRail.svelte', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/components/tv/TvHero.svelte', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/components/tv/TvSearch.svelte', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/components/tv/TvDetail.svelte', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/components/tv/TvMyList.svelte', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/tv/navigation.ts', import.meta.url), 'utf8')
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
assert.match(shellSource, /payload\.item\.type !== 'movie'/, 'TV detail must load seasons for Series and Anime');
assert.match(shellSource, /loadDetailRecommendations/);
assert.match(shellSource, /getLocalFavorites/);
assert.match(shellSource, /setFavoriteStatus/);
assert.match(shellSource, /removeFavoriteFromMyList/);
assert.match(shellSource, /syncAuthenticatedState/);
assert.match(shellSource, /if \(page\.data\.user\)/, 'TV cloud sync must remain authenticated-only');
assert.match(shellSource, /Array\.from\(item\.genres/ , 'TV favorite snapshots must materialize reactive genre arrays');
assert.match(shellSource, /if \(screen === 'my-list'\) void loadMyList\(\)/, 'Returning from detail to My List must refresh local items');
assert.match(shellSource, /details ready/);
assert.match(shellSource, /Player actions remain outside Phase 6/);
assert.match(detailSource, /Seasons and episodes/);
assert.match(detailSource, /item\.type !== 'movie'/, 'Anime and Series detail must render the season guide');
assert.match(detailSource, /tv-detail-my-list/);
assert.match(detailSource, /tv-detail-recommendations/);
assert.match(detailSource, /font-weight: 950/);
assert.match(myListSource, /Local-first/);
assert.match(myListSource, /tv-my-list/);
assert.match(navigationSource, /'detail'/);
assert.doesNotMatch(shellSource, /AVPlay/);
assert.doesNotMatch(shellSource, /supabase/);

console.log('TV contract tests passed: remote, navigation, focus, async states, route isolation, real Discover wiring, Search, Detail, My List, and strict player/auth boundaries.');
