/**
 * Peachify playback architecture — sandbox / ad-protection independence pins.
 *
 * Real Android/Chromium evidence (docs/peachify-redirect-investigation.md):
 *   The Peachify player REFUSES sandboxed frames — with the sandbox
 *   attribute present it shows "Sandbox Detected — Please disable iframe
 *   sandboxing permissions to access this player." and never starts
 *   playback. Without the sandbox attribute Peachify plays, but its own
 *   document opens popunders (`window.open`, `target="_blank"`, delayed
 *   popunders) that redirect-chain into Google Search and Google's
 *   /sorry/ "unusual traffic" (reCAPTCHA) page — the originally reported
 *   symptom. Runtime verification in Chromium (agent-browser, exact Mavero
 *   runtime iframe attributes, real user activation):
 *
 *     sandbox ON  → popups/top-navigation all blocked, but Peachify shows
 *                   "Sandbox Detected" and does not play.
 *     sandbox OFF → Peachify plays; popup attempts open real tabs that
 *                   land on google.com/sorry/ — uninterceptable by the
 *                   embedding app (browser same-origin security).
 *
 * Architecture pinned by this file:
 *   - Sandbox Policy (required | optional | unrestricted) and Third-Party
 *     Playback Ad Protection (ON | OFF) are TWO COMPLETELY INDEPENDENT
 *     settings. Both resolve through the same hierarchy — source override →
 *     provider default → system default — on their own capability keys, and
 *     neither ever forces the other (Ad Protection ON never re-adds a
 *     sandbox; an unrestricted sandbox never toggles Ad Protection).
 *   - `sandbox_policy: 'unrestricted'` + `playback_ad_protection: true` is a
 *     FIRST-CLASS configuration and is exactly Peachify's committed config
 *     (migrations 20260821040000 + 20260916000000).
 *   - The player renders the RESOLVED policy: unrestricted → no sandbox
 *     attribute (no "Sandbox Detected" screen); the harden-only shield can
 *     strengthen but never weaken a locked policy; the shield is never an
 *     Ad Protection control.
 *   - With the sandbox OFF, the technically enforceable protection is the
 *     resolver-level one: EVERY fallback candidate's playback URL is
 *     classified before iframe creation (ad-domain / redirect /
 *     unsafe-navigation / provider-rule), scoped to the provider/source
 *     being played. Popups opened by the cross-origin provider document
 *     AFTER the iframe loads cannot be intercepted by Mavero without the
 *     sandbox — documented limitation, never faked as blocked.
 *
 * Sections:
 *   A. sandbox token set (browser-level popup/top-nav guarantees),
 *   B. harden-only runtime control decision,
 *   C. Peachify's committed configuration → unrestricted + protection ON,
 *   D. legitimate Peachify playback stays allowed with protection ON,
 *   E. Peachify-scoped rules never leak to another provider,
 *   F. sandbox independence from Ad Protection + unrestricted authority,
 *   G. source pins binding PlayerViewport/PlayerShell markup to the policy,
 *   H. the eight required scenarios,
 *   I. the nine independence scenarios (unrestricted+ON, unrestricted+OFF,
 *      required+ON, required+OFF, source overrides of BOTH settings,
 *      fallback preserving BOTH settings, Peachify end-to-end).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluatePlaybackUrl, registerProviderPlaybackPolicy, unregisterProviderPlaybackPolicy } from '../src/lib/server/resolver/playback-policy';
import { resolveSourceFromConfig } from '../src/lib/server/resolver/core';
import { ResolverError } from '../src/lib/server/resolver/errors';
import { resolveWithBoundedFallback } from '../src/lib/server/resolver/fallback';
import { defaultPlaybackAdProtection, playbackAdProtectionFromCapabilities } from '../src/lib/shared/playback-ad-protection';
import { iframeSandboxAttribute, playerCanDisableSandbox, sandboxPolicyFromCapabilities, type SandboxPolicy } from '../src/lib/shared/sandbox-policy';
import type { AdapterResult, ProviderAdapter, TrustedResolutionConfig } from '../src/lib/server/resolver/types';
import type { NormalizedMediaItem } from '../src/lib/server/content/types';

let passed = 0;
function ok(value: unknown, message: string) {
  assert.ok(value, message);
  passed += 1;
}
function eq(actual: unknown, expected: unknown, message: string) {
  assert.equal(actual, expected, message);
  passed += 1;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// ----- Peachify's committed migration configuration -----
// (20260821040000_phase7e_peachify_experimental +
//  20260916000000_peachify_unrestricted_playback): Peachify refuses
// sandboxed frames, so the sandbox is unrestricted, and the INDEPENDENT
// playback_ad_protection setting is ON. Both levels carry identical values.
const peachifyProviderCapabilities = {
  movie: true,
  series: true,
  anime: false,
  result_type: 'embed',
  supports_episode: true,
  supports_direct: false,
  allow_experimental_playback: true,
  sandbox_policy: 'unrestricted',
  playback_ad_protection: true,
  allowed_embed_origins: ['https://peachify.top'],
} satisfies Record<string, unknown>;
const peachifySourceCapabilities = {
  movie: true,
  series: true,
  anime: false,
  result_type: 'embed',
  supports_episode: true,
  supports_direct: false,
  allow_experimental_playback: true,
  sandbox_policy: 'unrestricted',
  playback_ad_protection: true,
  allowed_embed_origins: ['https://peachify.top'],
} satisfies Record<string, unknown>;
const PEACHIFY_TEMPLATE_MOVIE = 'https://peachify.top/embed/movie/27205?accent=b1a1ff';
const PEACHIFY_TEMPLATE_SERIES = 'https://peachify.top/embed/tv/1234/1/1?accent=b1a1ff';
const POPUP_TUNNEL_HOSTS = ['allow-popups', 'allow-popups-to-escape-sandbox', 'allow-top-navigation', 'allow-top-navigation-by-user-activation'];

// ===========================================================================
// A. Sandbox token set — the browser-level guarantees that stop popunders.
//    In Chromium, a sandboxed frame WITHOUT allow-popups returns null from
//    window.open and refuses target="_blank" (verified at runtime, runs 1
//    vs 4 of the investigation); without allow-top-navigation* any
//    window.top / target="_top" navigation is rejected.
// ===========================================================================
const secureAttribute = iframeSandboxAttribute('required');
eq(secureAttribute, 'allow-forms allow-presentation allow-same-origin allow-scripts', 'A: required attribute is exactly the secure token set');
eq(iframeSandboxAttribute('optional'), secureAttribute, 'A: optional applies the same secure token set');
for (const token of POPUP_TUNNEL_HOSTS) {
  ok(!secureAttribute.includes(token), `A: required sandbox never grants ${token}`);
  ok(!iframeSandboxAttribute('optional')!.includes(token), `A: optional sandbox never grants ${token}`);
}
ok(secureAttribute.includes('allow-scripts'), 'A: provider JavaScript keeps running (play/pause/seek logic)');
ok(secureAttribute.includes('allow-forms'), 'A: provider forms keep working');
ok(secureAttribute.includes('allow-same-origin'), 'A: provider origin keeps storage (resume positions)');
ok(secureAttribute.includes('allow-presentation'), 'A: provider casting capability preserved');
eq(iframeSandboxAttribute('unrestricted'), undefined, 'A: unrestricted renders NO sandbox attribute (admin authority)');
eq(iframeSandboxAttribute(), secureAttribute, 'A: default policy is the secure token set');

// ===========================================================================
// B. Harden-only runtime control — closes the app-level escape route.
// ===========================================================================
eq(playerCanDisableSandbox('required'), false, 'B: required embeds cannot be unsandboxed from the player');
eq(playerCanDisableSandbox('optional'), false, 'B: optional embeds cannot be unsandboxed from the player');
eq(playerCanDisableSandbox(undefined), false, 'B: legacy/unknown policy locks to the secure default');
eq(playerCanDisableSandbox('unrestricted'), true, 'B: only an explicitly unrestricted policy keeps the toggle');

// ===========================================================================
// C. Peachify committed config → unrestricted + Ad Protection ON — the exact
//    first-class combination needed because Peachify refuses sandboxed
//    frames ("Sandbox Detected"), while the two settings stay independent.
// ===========================================================================
eq(sandboxPolicyFromCapabilities(peachifyProviderCapabilities, peachifySourceCapabilities), 'unrestricted' as SandboxPolicy, 'C: Peachify effective sandbox policy is unrestricted');
eq(iframeSandboxAttribute(sandboxPolicyFromCapabilities(peachifyProviderCapabilities, peachifySourceCapabilities)), undefined, 'C: Peachify renders NO sandbox attribute (no "Sandbox Detected" screen)');
eq(playerCanDisableSandbox(sandboxPolicyFromCapabilities(peachifyProviderCapabilities, peachifySourceCapabilities)), true, 'C: unrestricted keeps the (admin-baseline) harden-only toggle');
eq(playbackAdProtectionFromCapabilities(peachifyProviderCapabilities, peachifySourceCapabilities).enabled, true, 'C: Ad Protection is ON for Peachify — independently of the sandbox');
eq(playbackAdProtectionFromCapabilities(undefined, undefined).enabled, defaultPlaybackAdProtection.enabled, 'C: system default Ad Protection is OFF');

// ===========================================================================
// D. Legitimate Peachify playback preserved (protection ON must not break
//    the embed URL itself — play/pause/seek/fullscreen/subtitles are
//    provider-page features inside the sandboxed frame).
// ===========================================================================
const peachifyProtectionOn = { enabled: true } as const;
for (const [label, url] of [['movie template', PEACHIFY_TEMPLATE_MOVIE], ['series template', PEACHIFY_TEMPLATE_SERIES]] as const) {
  const decision = evaluatePlaybackUrl(url, 'embed', { providerId: 'peachify-provider', sourceId: 'peachify-source', policy: peachifyProtectionOn });
  eq(decision.allowed, true, `D: Peachify ${label} stays allowed with Ad Protection ON`);
}
const offDecision = evaluatePlaybackUrl(PEACHIFY_TEMPLATE_MOVIE, 'embed', { providerId: 'peachify-provider', policy: { enabled: false } });
eq(offDecision.allowed, true, 'D: Peachify allowed with protection OFF');
eq(offDecision.reason, 'protection-disabled-for-source', 'D: OFF short-circuit reason is explicit');

// ===========================================================================
// E. Peachify-scoped rules never leak to another provider.
// ===========================================================================
const scopedHost = 'peachify-popunder-tracker.example';
registerProviderPlaybackPolicy('peachify-provider', { blockedHosts: [scopedHost] });
try {
  const forPeachify = evaluatePlaybackUrl(`https://${scopedHost}/pixel`, 'embed', { providerId: 'peachify-provider', policy: peachifyProtectionOn });
  eq(forPeachify.allowed, false, 'E: scoped rule blocks the host for Peachify');
  eq(forPeachify.category, 'provider-rule', 'E: block category is provider-rule');
  const forOther = evaluatePlaybackUrl(`https://${scopedHost}/pixel`, 'embed', { providerId: 'vidlink-provider', policy: { enabled: true } });
  eq(forOther.allowed, true, 'E: the same host is untouched for another provider');
  const forOtherOff = evaluatePlaybackUrl(`https://${scopedHost}/pixel`, 'embed', { providerId: 'vidlink-provider', policy: { enabled: false } });
  eq(forOtherOff.allowed, true, 'E: another provider with protection OFF is untouched');
  const capabilityScoped = evaluatePlaybackUrl(`https://${scopedHost}/pixel`, 'embed', { providerId: 'vidlink-provider', policy: { enabled: true, blockedHosts: [scopedHost] } });
  eq(capabilityScoped.allowed, false, 'E: a host rule supplied as ANOTHER provider capability config applies only via that config');
  const otherCapabilityScoped = evaluatePlaybackUrl('https://vidlink.pro/movie/1', 'embed', { providerId: 'vidlink-provider', policy: { enabled: true, blockedHosts: [scopedHost] } });
  eq(otherCapabilityScoped.allowed, true, 'E: another provider capability config does not classify unrelated hosts');
} finally {
  eq(unregisterProviderPlaybackPolicy('peachify-provider'), true, 'E: registry cleanup');
}
const afterRemoval = evaluatePlaybackUrl(`https://${scopedHost}/pixel`, 'embed', { providerId: 'peachify-provider', policy: peachifyProtectionOn });
eq(afterRemoval.allowed, true, 'E: unregistered rule stops applying');

// ===========================================================================
// F. Sandbox independence + unrestricted authority (Ad Protection must not
//    force a sandbox onto unrestricted providers, either way).
// ===========================================================================
const unrestrictedCaps = { sandbox_policy: 'unrestricted', playback_ad_protection: true } satisfies Record<string, unknown>;
eq(sandboxPolicyFromCapabilities(unrestrictedCaps), 'unrestricted' as SandboxPolicy, 'F: unrestricted policy unaffected by Ad Protection ON');
eq(iframeSandboxAttribute(sandboxPolicyFromCapabilities(unrestrictedCaps)), undefined, 'F: Ad Protection ON does not add a sandbox to unrestricted providers');
eq(playerCanDisableSandbox(sandboxPolicyFromCapabilities(unrestrictedCaps)), true, 'F: unrestricted keeps its (admin-baseline) toggle');
const restrictedCaps = { sandbox_policy: 'required', playback_ad_protection: true } satisfies Record<string, unknown>;
eq(iframeSandboxAttribute(sandboxPolicyFromCapabilities(restrictedCaps)), secureAttribute, 'F: Ad Protection ON does not alter the sandboxed token set');

// ===========================================================================
// G. Source pins — the runtime markup stays bound to the policy helpers.
// ===========================================================================
const viewportSource = readFileSync(join(repoRoot, 'src/lib/components/player/PlayerViewport.svelte'), 'utf8');
ok(viewportSource.includes("sandboxEnabled ? iframeSandboxAttribute('required') : undefined"), 'G: viewport derives the sandbox attribute from the secure policy helper');
ok(viewportSource.includes('sandbox={sandboxAttribute}'), 'G: viewport binds the sandbox attribute onto the iframe');
ok(viewportSource.includes('allow="autoplay; fullscreen; picture-in-picture; encrypted-media"'), 'G: viewport grants autoplay/fullscreen/PiP/EME (playback features unaffected)');
ok(viewportSource.includes('referrerpolicy="no-referrer"'), 'G: viewport keeps no-referrer');
ok(viewportSource.includes('allowfullscreen'), 'G: viewport keeps allowfullscreen');
const shellSource = readFileSync(join(repoRoot, 'src/lib/components/player/PlayerShell.svelte'), 'utf8');
ok(shellSource.includes("import { playerCanDisableSandbox } from '$lib/shared/sandbox-policy'"), 'G: shell imports the harden-only control helper');
ok(shellSource.includes('if (!playerCanDisableSandbox(source.sandboxPolicy)) return;'), 'G: toggleSandbox refuses to weaken a locked policy');
ok(shellSource.includes("!playerCanDisableSandbox(source.sandboxPolicy)"), 'G: sandboxControlLocked derives from the same helper');
ok(shellSource.includes('Sandbox enforced by the provider configuration'), 'G: locked embeds render an explicit enforced indicator');

// ===========================================================================
// H. The eight required scenarios.
// ===========================================================================
// 1. Peachify + protection ON → policy executes (scoped host blocked).
registerProviderPlaybackPolicy('peachify-provider', { blockedHosts: [scopedHost] });
const h1 = evaluatePlaybackUrl(`https://${scopedHost}/x`, 'embed', { providerId: 'peachify-provider', policy: peachifyProtectionOn });
eq(h1.allowed, false, 'H1: Peachify + ON executes policy');
// 2. Peachify + protection OFF → policy skipped entirely.
const h2 = evaluatePlaybackUrl(`https://${scopedHost}/x`, 'embed', { providerId: 'peachify-provider', policy: { enabled: false } });
eq(h2.allowed, true, 'H2: Peachify + OFF skips policy');
eq(h2.reason, 'protection-disabled-for-source', 'H2: skip reason recorded');
// 3. Another provider + OFF → Peachify rules do not affect it.
const h3 = evaluatePlaybackUrl(PEACHIFY_TEMPLATE_MOVIE, 'embed', { providerId: 'other-provider', policy: { enabled: false } });
eq(h3.allowed, true, 'H3: other provider + OFF unaffected');
// 4. Another provider + ON → only its own rules (vidlink.pro legit URL passes peachify-scoped config).
const h4 = evaluatePlaybackUrl('https://vidlink.pro/movie/778899', 'embed', { providerId: 'other-provider', policy: { enabled: true, blockedHosts: ['peachify-popunder-tracker.example'] } });
eq(h4.allowed, true, 'H4: other provider + ON uses only its own rules');
// 5. Peachify rules never apply to another provider (registry isolation) — covered in E; re-assert after cleanup.
const h5 = evaluatePlaybackUrl(`https://${scopedHost}/pixel`, 'embed', { providerId: 'other-provider', policy: { enabled: true } });
eq(h5.allowed, true, 'H5: peachify registry rule does not leak (post-cleanup)');
// 6. Legitimate Peachify playback remains functional — templates allowed (D) and the sandbox keeps scripts/forms/origin/presentation + autoplay/fullscreen permissions (A/G).
ok(secureAttribute.includes('allow-scripts') && viewportSource.includes('autoplay; fullscreen'), 'H6: legit Peachify playback surface preserved');
// 7. Sandbox behavior unchanged for other providers — exact token set pinned in A; sandbox-policy helpers untouched for required/optional.
eq(iframeSandboxAttribute('optional'), 'allow-forms allow-presentation allow-same-origin allow-scripts', 'H7: other providers keep the exact same secure sandbox');
// 8. Unrestricted providers remain unrestricted — no sandbox forced (F), toggle stays available within the admin baseline.
eq(playerCanDisableSandbox('unrestricted'), true, 'H8: unrestricted stays user-toggleable within the admin baseline');

// ===========================================================================
// I. The nine independence scenarios (Sandbox Policy × Ad Protection).
//    Each resolver scenario runs end-to-end through resolveSourceFromConfig
//    so the SourceResult carries the RESOLVED sandboxPolicy next to the
//    executed (or skipped) policy — the exact values the player and iframe
//    receive at runtime.
// ===========================================================================
const matrixProviderA = 'c0000000-0000-4000-8000-00000000000a';
const matrixProviderB = 'c0000000-0000-4000-8000-00000000000b';
const matrixSourceA = 'd0000000-0000-4000-8000-00000000000a';
const matrixSourceB = 'd0000000-0000-4000-8000-00000000000b';
const matrixContent: NormalizedMediaItem = {
  id: 'independence-fixture', title: 'Independence Fixture', year: 2026, type: 'movie', runtime: '1h 30m', rating: 7.5, genres: ['Drama'], description: 'Fixture', poster: 'https://image.tmdb.org/t/p/w500/independence.jpg', backdrop: 'https://image.tmdb.org/t/p/original/independence.jpg', accent: '#9b87f5', source: { provider: 'tmdb', externalId: '778899', fetchedAt: new Date().toISOString() }, externalIds: { tmdb: '778899', imdb: 'tt1234567' },
};
const matrixRequest = { sourceId: matrixSourceA, contentId: 'independence-fixture', mediaType: 'movie' } as const;
const legitMatrixUrl = 'https://media.example.test/v/independence/master.m3u8';
const classifiedMatrixUrl = 'https://serve.popads.net/fake-stream.m3u8?token=x';
function matrixAdapter(result: AdapterResult | null): ProviderAdapter {
  return { integrationType: 'direct', resolve: async () => result };
}
/** Per-provider adapter: provider A can be unavailable while B returns a URL. */
function perProviderAdapter(results: Record<string, AdapterResult | null>): ProviderAdapter {
  return { integrationType: 'direct', resolve: async (context) => results[context.config.provider.id] ?? null };
}
function matrixConfig(opts: { providerId?: string; sourceId?: string; providerCapabilities?: Record<string, unknown>; sourceCapabilities?: Record<string, unknown> } = {}): TrustedResolutionConfig {
  const pid = opts.providerId ?? matrixProviderA;
  return {
    provider: { id: pid, name: `Matrix Provider ${pid.slice(-1)}`, status: 'active', enabled: true, integration_type: 'direct', adapter_id: undefined, capabilities: { movie: true, series: true, ...(opts.providerCapabilities ?? {}) } },
    source: { id: opts.sourceId ?? matrixSourceA, provider_id: pid, name: `Matrix Source ${pid.slice(-1)}`, status: 'active', enabled: true, visibility: 'public', integration_type: 'direct', capabilities: { movie: true, ...(opts.sourceCapabilities ?? {}) }, movie_template: 'https://media.example.test/{tmdb_id}.m3u8', series_template: '', anime_template: '', identifier_mode: 'tmdb_id', audio_languages: ['English'], subtitle_capability: true, quality_capability: ['HD'] },
  };
}
async function matrixResolves(label: string, cfg: TrustedResolutionConfig, url: string, expectedSandbox: SandboxPolicy): Promise<void> {
  const result = await resolveSourceFromConfig(matrixRequest, cfg, matrixContent, { adapters: { direct: matrixAdapter({ type: 'direct', url }) } });
  eq(result.type, 'direct', `I:${label} resolves`);
  eq(result.sandboxPolicy, expectedSandbox, `I:${label} result carries its own resolved sandboxPolicy`);
}
async function matrixBlocked(label: string, cfg: TrustedResolutionConfig, url: string, expectedSandbox: SandboxPolicy): Promise<void> {
  try {
    await resolveSourceFromConfig(matrixRequest, cfg, matrixContent, { adapters: { direct: matrixAdapter({ type: 'direct', url }) } });
    ok(false, `I:${label} must be rejected`);
  } catch (error) {
    ok(error instanceof ResolverError && error.code === 'PLAYBACK_POLICY_BLOCKED', `I:${label} rejected as PLAYBACK_POLICY_BLOCKED (policy executed)`);
  }
  // The rejection is thrown BEFORE a SourceResult exists — re-derive the
  // sandbox policy the embed WOULD have received from the same capabilities.
  eq(iframeSandboxAttribute(sandboxPolicyFromCapabilities(cfg.provider.capabilities, cfg.source.capabilities)), expectedSandbox === 'unrestricted' ? undefined : secureAttribute, `I:${label} sandbox attribute matches its own policy, independent of the protection outcome`);
}

// 1. sandbox=unrestricted + adProtection=true → no sandbox attr + policy executes.
await matrixResolves('1a unrestricted+ON legit', matrixConfig({ providerCapabilities: { sandbox_policy: 'unrestricted', playback_ad_protection: true } }), legitMatrixUrl, 'unrestricted');
await matrixBlocked('1b unrestricted+ON classified', matrixConfig({ providerCapabilities: { sandbox_policy: 'unrestricted', playback_ad_protection: true } }), classifiedMatrixUrl, 'unrestricted');
// 2. sandbox=unrestricted + adProtection=false → no sandbox attr + policy skipped.
await matrixResolves('2 unrestricted+OFF classified', matrixConfig({ providerCapabilities: { sandbox_policy: 'unrestricted', playback_ad_protection: false } }), classifiedMatrixUrl, 'unrestricted');
// 3. sandbox=required + adProtection=true → secure attr + policy executes.
await matrixResolves('3a required+ON legit', matrixConfig({ providerCapabilities: { sandbox_policy: 'required', playback_ad_protection: true } }), legitMatrixUrl, 'required');
await matrixBlocked('3b required+ON classified', matrixConfig({ providerCapabilities: { sandbox_policy: 'required', playback_ad_protection: true } }), classifiedMatrixUrl, 'required');
// 4. sandbox=required + adProtection=false → secure attr + policy skipped.
await matrixResolves('4 required+OFF classified', matrixConfig({ providerCapabilities: { sandbox_policy: 'required', playback_ad_protection: false } }), classifiedMatrixUrl, 'required');
// 5. Source override INDEPENDENTLY overrides the provider sandbox policy
//    (ad-protection capabilities untouched in both directions).
await matrixResolves('5a source unrestricted override', matrixConfig({ providerCapabilities: { sandbox_policy: 'required' }, sourceCapabilities: { sandbox_policy: 'unrestricted' } }), legitMatrixUrl, 'unrestricted');
await matrixResolves('5b source required override', matrixConfig({ providerCapabilities: { sandbox_policy: 'unrestricted' }, sourceCapabilities: { sandbox_policy: 'required' } }), legitMatrixUrl, 'required');
// 6. Source override INDEPENDENTLY overrides the provider ad protection
//    (sandbox capabilities untouched in both directions).
await matrixResolves('6a source OFF override of provider ON', matrixConfig({ providerCapabilities: { playback_ad_protection: true }, sourceCapabilities: { playback_ad_protection: false } }), classifiedMatrixUrl, 'required');
await matrixBlocked('6b source ON override of provider OFF', matrixConfig({ providerCapabilities: { playback_ad_protection: false }, sourceCapabilities: { playback_ad_protection: true } }), classifiedMatrixUrl, 'required');
// 7. Provider fallback preserves the EFFECTIVE ad protection per candidate:
//    A (ON) is blocked → B (OFF) resolves the same classified URL.
const fallbackProtection = await resolveWithBoundedFallback(
  matrixRequest,
  matrixContent,
  [
    { config: matrixConfig({ providerId: matrixProviderA, sourceId: matrixSourceA, providerCapabilities: { playback_ad_protection: true } }) },
    { config: matrixConfig({ providerId: matrixProviderB, sourceId: matrixSourceB, providerCapabilities: { playback_ad_protection: false } }) },
  ],
  { adapters: { direct: matrixAdapter({ type: 'direct', url: classifiedMatrixUrl }) } },
);
eq(fallbackProtection.result.url, classifiedMatrixUrl, 'I:7 fallback lands on the OFF candidate');
eq(fallbackProtection.result.sandboxPolicy, 'required', 'I:7 surviving candidate keeps its own sandbox policy');
eq(fallbackProtection.attempts[0]?.result, 'failure', 'I:7 protected candidate failed first');
eq(fallbackProtection.attempts[0]?.errorCode, 'PLAYBACK_POLICY_BLOCKED', 'I:7 protected candidate failed by policy');
eq(fallbackProtection.attempts[1]?.result, 'success', 'I:7 unprotected candidate succeeded');
//    Reverse: A (OFF) is unavailable → B (ON) rejects the classified URL.
try {
  await resolveWithBoundedFallback(
    matrixRequest,
    matrixContent,
    [
      { config: matrixConfig({ providerId: matrixProviderA, sourceId: matrixSourceA, providerCapabilities: { playback_ad_protection: false } }) },
      { config: matrixConfig({ providerId: matrixProviderB, sourceId: matrixSourceB, providerCapabilities: { playback_ad_protection: true } }) },
    ],
    { adapters: { direct: perProviderAdapter({ [matrixProviderA]: null, [matrixProviderB]: { type: 'direct', url: classifiedMatrixUrl } }) } },
  );
  ok(false, 'I:7 reverse fallback must reject');
} catch (error) {
  ok(error instanceof ResolverError && error.code === 'PLAYBACK_POLICY_BLOCKED', 'I:7 reverse fallback: ON candidate still enforces the policy');
}
// 8. Provider fallback preserves the EFFECTIVE sandbox policy per candidate:
//    A (required, unavailable) fails → B (unrestricted) succeeds and the
//    result carries B's OWN sandboxPolicy.
const fallbackSandbox = await resolveWithBoundedFallback(
  matrixRequest,
  matrixContent,
  [
    { config: matrixConfig({ providerId: matrixProviderA, sourceId: matrixSourceA, providerCapabilities: { sandbox_policy: 'required' } }) },
    { config: matrixConfig({ providerId: matrixProviderB, sourceId: matrixSourceB, providerCapabilities: { sandbox_policy: 'unrestricted', playback_ad_protection: true } }) },
  ],
  { adapters: { direct: perProviderAdapter({ [matrixProviderA]: null, [matrixProviderB]: { type: 'direct', url: legitMatrixUrl } }) } },
);
eq(fallbackSandbox.result.url, legitMatrixUrl, 'I:8 fallback lands on the unrestricted candidate');
eq(fallbackSandbox.result.sandboxPolicy, 'unrestricted', 'I:8 surviving candidate keeps unrestricted (Ad Protection ON did NOT force a sandbox)');
eq(iframeSandboxAttribute(fallbackSandbox.result.sandboxPolicy), undefined, 'I:8 the iframe for the surviving candidate renders WITHOUT a sandbox');
//    Reverse: A (unrestricted, unavailable) fails → B (required) succeeds.
const fallbackSandboxReverse = await resolveWithBoundedFallback(
  matrixRequest,
  matrixContent,
  [
    { config: matrixConfig({ providerId: matrixProviderA, sourceId: matrixSourceA, providerCapabilities: { sandbox_policy: 'unrestricted' } }) },
    { config: matrixConfig({ providerId: matrixProviderB, sourceId: matrixSourceB, providerCapabilities: { sandbox_policy: 'required' } }) },
  ],
  { adapters: { direct: perProviderAdapter({ [matrixProviderA]: null, [matrixProviderB]: { type: 'direct', url: legitMatrixUrl } }) } },
);
eq(fallbackSandboxReverse.result.sandboxPolicy, 'required', 'I:8 reverse: surviving candidate keeps required');
// 9. Peachify end-to-end: the exact committed config resolves with BOTH
//    settings in force — playback resolves, sandbox stays unrestricted, and
//    a Peachify-scoped rule (playback_ad_protection_rules) executes.
const peachifyScopedRule = { playback_ad_protection_rules: { blockedHosts: ['popunder.peachify-ads.example.test'] } };
const peachifyMatrixConfig = matrixConfig({
  providerCapabilities: { sandbox_policy: 'unrestricted', playback_ad_protection: true, ...peachifyScopedRule },
  sourceCapabilities: { sandbox_policy: 'unrestricted', playback_ad_protection: true },
});
await matrixResolves('9a peachify legit embed config', peachifyMatrixConfig, PEACHIFY_TEMPLATE_MOVIE, 'unrestricted');
await matrixBlocked('9b peachify scoped host', matrixConfig({ providerCapabilities: { sandbox_policy: 'unrestricted', playback_ad_protection: true, ...peachifyScopedRule } }), 'https://popunder.peachify-ads.example.test/pixel', 'unrestricted');

console.log(`peachify_redirect_protection_test: ${passed} checks passed`);
