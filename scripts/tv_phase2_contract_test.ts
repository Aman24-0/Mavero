import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTVNavigation } from '../src/lib/tv/navigation';
import { getTVRemoteAction, isBackAction, isNavigationAction } from '../src/lib/tv/remote';

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

const [focusSource, shellSource, routeSource, routeServerSource, mediaRailSource, heroSource] = await Promise.all([
  readFile(new URL('../src/lib/tv/focus.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/components/tv/TvShell.svelte', import.meta.url), 'utf8'),
  readFile(new URL('../src/routes/tv/+page.svelte', import.meta.url), 'utf8'),
  readFile(new URL('../src/routes/tv/+page.server.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/components/tv/TvMediaRail.svelte', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/components/tv/TvHero.svelte', import.meta.url), 'utf8')
]);

assert.match(focusSource, /tvFocusGroup/);
assert.match(focusSource, /restoreFirst/);
assert.match(focusSource, /scrollIntoView/);
assert.match(focusSource, /move\(direction: FocusDirection, scope\?: string\)/);
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
assert.match(heroSource, /Featured from Discover/);
assert.match(shellSource, /Phase 3 connects Discover data first/);

console.log('TV contract tests passed: remote, navigation, focus, async states, route isolation, and real Discover wiring.');
