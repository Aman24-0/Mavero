import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/routes/search/+page.svelte', import.meta.url), 'utf8');

// The Search page imports `onDestroy` from svelte for the request/race
// cleanup. The previous $effect/untrack workaround was removed in favor
// of a SvelteKit `export const snapshot` — the import must NOT include
// `untrack` anymore.
assert.match(source, /import \{ onDestroy \} from 'svelte'/);
assert.doesNotMatch(source, /import \{[^}]*\buntrack\b/);
assert.match(source, /import \{ replaceState \} from '\$app\/navigation'/);
assert.match(source, /replaceState\(`/);
assert.doesNotMatch(source, /\bgoto\(/);
assert.match(source, /let requestController: AbortController \| undefined/);
assert.match(source, /let requestSequence = 0/);
assert.match(source, /let routeActive = true/);
assert.match(source, /page\.url\.pathname === '\/search'/);
assert.match(source, /requestController\?\.abort\(\)/);
assert.match(source, /signal: controller\.signal/);
assert.match(source, /requestId !== requestSequence \|\| controller\.signal\.aborted \|\| !isSearchRouteActive\(\)/);
assert.match(source, /if \(controller\.signal\.aborted \|\| requestId !== requestSequence \|\| !isSearchRouteActive\(\)\) return/);
assert.match(source, /onDestroy\(\(\) => \{/);
assert.match(source, /routeActive = false/);
assert.match(source, /clearTimeout\(timer\)/);
assert.match(source, /requestSequence \+= 1/);

console.log('Search-to-Discover stale-request regression contract tests passed');
