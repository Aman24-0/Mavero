import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parsePlayerMode, resolutionPolicyForPlayerMode, withPlayerMode } from '../src/lib/shared/player-mode';

const watchRoute = await readFile(new URL('../src/routes/watch/[type]/[id]/+page.svelte', import.meta.url), 'utf8');
const playerShell = await readFile(new URL('../src/lib/components/player/PlayerShell.svelte', import.meta.url), 'utf8');
const playerViewport = await readFile(new URL('../src/lib/components/player/PlayerViewport.svelte', import.meta.url), 'utf8');
const choice = await readFile(new URL('../src/lib/components/player/PlayerModeChoice.svelte', import.meta.url), 'utf8');

assert.equal(parsePlayerMode('source'), 'source');
assert.equal(parsePlayerMode('native'), 'native');
assert.equal(parsePlayerMode(undefined), null);
assert.equal(parsePlayerMode('invalid'), null);

assert.deepEqual(resolutionPolicyForPlayerMode('source'), { aggregate: false, enableFallback: true });
assert.deepEqual(resolutionPolicyForPlayerMode('native'), { aggregate: true, enableFallback: true });
assert.deepEqual(resolutionPolicyForPlayerMode('source', false), { aggregate: false, enableFallback: false });
assert.deepEqual(resolutionPolicyForPlayerMode('native', false), { aggregate: false, enableFallback: false });

const query = new URLSearchParams('season=2&episode=4&from=%2Fseries%2Ffixture');
assert.equal(withPlayerMode('/watch/series/fixture', query, 'source'), '/watch/series/fixture?season=2&episode=4&from=%2Fseries%2Ffixture&player=source');
assert.equal(withPlayerMode('/watch/series/fixture', query, 'native'), '/watch/series/fixture?season=2&episode=4&from=%2Fseries%2Ffixture&player=native');
assert.equal(query.get('player'), null);

assert.match(choice, /Source Player/);
assert.match(choice, /Native Player/);
assert.match(choice, /onSelect\('source'\)/);
assert.match(choice, /onSelect\('native'\)/);
assert.match(choice, /Native Player remains available for independent testing/);

assert.match(watchRoute, /parsePlayerMode/);
assert.match(watchRoute, /resolutionPolicyForPlayerMode/);
assert.match(watchRoute, /aggregate: automaticAggregation/);
assert.match(watchRoute, /activePlayerMode === 'native'/);
assert.match(watchRoute, /PlayerModeChoice/);
assert.match(watchRoute, /onUseSourcePlayer/);
assert.match(watchRoute, /playerSourceOptions/);
assert.match(watchRoute, /prepareSource\(sourceId, false, false\)/);
assert.doesNotMatch(watchRoute, /aggregate: true[^\n]*source/);

assert.match(playerShell, /export let mode: 'source' \| 'native'/);
assert.match(playerShell, /mode === 'native'/);
assert.match(playerShell, /onUseSourcePlayer/);
assert.match(playerShell, /Native Player · Experimental/);
assert.match(playerShell, /nativePlayback=\{mode === 'native'\}/);
assert.match(playerViewport, /export let nativePlayback = false/);
assert.match(playerViewport, /if \(!nativePlayback\)/);
assert.match(playerViewport, /import\('hls\.js'\)/);
assert.match(playerViewport, /import\('dashjs'\)/);

console.log('Player mode isolation tests passed: explicit choice, URL state, Source Player legacy policy, Native Player aggregation policy, TV query preservation, failure crossover boundary, and native-loader gating.');
