import assert from 'node:assert/strict';
import { isRedirect, redirect } from '@sveltejs/kit';
import { classifyAdminMutationError, type AdminMutationResult } from '../src/lib/server/streaming/mutation-result';
import { iframeSandboxAttribute, sandboxPolicyFromCapabilities, sandboxPolicyDescription, withSandboxPolicy } from '../src/lib/shared/sandbox-policy';
import { adjacentSource, stateForSource } from '../src/lib/shared/player-state';
import { isPlayablePlayerSource, normalizePlayerSource } from '../src/lib/shared/player-guards';
import type { PlayerSource, PlayerSourceOption } from '../src/lib/shared/player';

const sources: PlayerSourceOption[] = [
  { id: 'vidsrc', name: 'Vidsrc', status: 'experimental', integrationType: 'embed' },
  { id: 'vidlink', name: 'VidLink', status: 'experimental', integrationType: 'embed' },
  { id: 'third', name: 'Third', status: 'active', integrationType: 'embed' },
];

assert.equal(adjacentSource(sources, 'vidsrc', -1), undefined);
assert.equal(adjacentSource(sources, 'vidsrc', 1), 'vidlink');
assert.equal(adjacentSource(sources, 'vidlink', -1), 'vidsrc');
assert.equal(adjacentSource(sources, 'vidlink', 1), 'third');
assert.equal(adjacentSource(sources, 'third', 1), undefined);
assert.equal(adjacentSource(sources, 'missing', 1), undefined);

assert.equal(sandboxPolicyFromCapabilities({}), 'required');
assert.equal(sandboxPolicyFromCapabilities({ sandbox_policy: 'optional' }), 'optional');
assert.equal(sandboxPolicyFromCapabilities({ sandbox_policy: 'unrestricted' }), 'unrestricted');
assert.equal(sandboxPolicyFromCapabilities({ sandbox_policy: 'invalid' }), 'required');
assert.equal(iframeSandboxAttribute('required')?.includes('allow-scripts'), true);
assert.equal(iframeSandboxAttribute('optional')?.includes('allow-same-origin'), true);
assert.equal(iframeSandboxAttribute('unrestricted'), undefined);
assert.equal(sandboxPolicyDescription('unrestricted').includes('Sandbox disabled'), true);
assert.deepEqual(withSandboxPolicy({ movie: true }, 'required'), { movie: true, sandbox_policy: 'required' });

const embed: PlayerSource = {
  type: 'embed',
  url: 'https://vidlink.pro/movie/778899',
  providerId: 'provider-vidlink',
  sourceId: 'source-vidlink',
  mediaType: 'movie',
  sandboxPolicy: 'required',
};
assert.equal(isPlayablePlayerSource(embed), true);
assert.equal(stateForSource(embed), 'embed-loading');
assert.deepEqual(normalizePlayerSource(embed), embed);
assert.equal(normalizePlayerSource({ ...embed, sandboxPolicy: 'not-a-policy' }), null);

let redirectError: unknown;
try {
  throw redirect(303, '/admin/sources?notice=Source%20state%20updated.');
} catch (error) {
  redirectError = error;
}
assert.equal(isRedirect(redirectError), true);

const failure = classifyAdminMutationError(new Error('permission denied'), 'fallback');
assert.deepEqual(failure, { status: 'failure', message: 'permission denied' });
const timeout = classifyAdminMutationError(Object.assign(new Error('request timed out'), { name: 'AbortError' }), 'fallback');
assert.equal(timeout.status, 'unknown');
assert.equal('message' in timeout, true);
const unknown: AdminMutationResult = { status: 'unknown', message: 'ambiguous' };
assert.equal(unknown.status, 'unknown');

console.log('Phase 7E remediation tests passed: truthful redirects, mutation outcomes, sandbox policy, source ordering, and player boundaries.');
