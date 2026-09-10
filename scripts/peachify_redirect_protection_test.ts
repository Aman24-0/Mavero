/**
 * Peachify unwanted external redirect — mechanism pins and protection tests.
 *
 * Investigation summary (docs/peachify-redirect-investigation.md):
 *   The Peachify → Google Search → reCAPTCHA behavior observed on a real
 *   Android device is a POPUNDER: the provider document opens a NEW window
 *   (`window.open`, `target="_blank"` anchors, and delayed "late" popunders)
 *   after the iframe has loaded. The new tab redirect-chains into Google
 *   Search, and Google serves its /sorry/ "unusual traffic" (reCAPTCHA)
 *   page. Runtime verification in Chromium (agent-browser, exact Mavero
 *   runtime iframe attributes, real user activation):
 *
 *     sandbox ON  (required policy attrs) → window.open returns null, no
 *                 tab opens, top navigation blocked (SecurityError), and
 *                 even a service worker registered from the sandboxed frame
 *                 is refused clients.openWindow() (InvalidAccessError).
 *     sandbox OFF → every popup attempt opens a real tab that lands on
 *                 google.com/sorry/ — the exact reported symptom.
 *
 *   Therefore the ONLY app-level route that reproduces the bug is rendering
 *   the embed WITHOUT the sandbox attribute. The committed Peachify config
 *   is `sandbox_policy: 'required'` (provider AND source), so the runtime
 *   escape route was the player's one-tap sandbox shield, which could
 *   silently disable the sandbox. The fix makes that control HARDEN-ONLY:
 *   required/optional embeds are locked ON for the session; only an
 *   explicitly `unrestricted` admin policy keeps the toggle available
 *   (within the admin's own baseline). Admin remains authoritative.
 *
 * This file pins:
 *   A. the sandbox token set (the browser-level popup/top-nav guarantees),
 *   B. the harden-only runtime control decision,
 *   C. Peachify's committed configuration resolves to the locked-secure
 *      state, with Ad Protection still OFF by default,
 *   D. legitimate Peachify playback URLs stay allowed with protection ON,
 *   E. Peachify-scoped rules never leak to another provider,
 *   F. sandbox independence from Ad Protection + unrestricted authority,
 *   G. source pins binding PlayerViewport/PlayerShell markup to the policy,
 *   H. the 8 required scenarios from the task specification.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluatePlaybackUrl, registerProviderPlaybackPolicy, unregisterProviderPlaybackPolicy } from '../src/lib/server/resolver/playback-policy';
import { defaultPlaybackAdProtection, playbackAdProtectionFromCapabilities } from '../src/lib/shared/playback-ad-protection';
import { iframeSandboxAttribute, playerCanDisableSandbox, sandboxPolicyFromCapabilities, type SandboxPolicy } from '../src/lib/shared/sandbox-policy';

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

// ----- Peachify's committed migration configuration (20260821040000) -----
const peachifyProviderCapabilities = {
  movie: true,
  series: true,
  anime: false,
  result_type: 'embed',
  supports_episode: true,
  supports_direct: false,
  allow_experimental_playback: true,
  sandbox_policy: 'required',
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
  sandbox_policy: 'required',
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
// C. Peachify committed config → locked-secure + Ad Protection default OFF.
// ===========================================================================
eq(sandboxPolicyFromCapabilities(peachifyProviderCapabilities, peachifySourceCapabilities), 'required' as SandboxPolicy, 'C: Peachify effective sandbox policy is required');
eq(playerCanDisableSandbox(sandboxPolicyFromCapabilities(peachifyProviderCapabilities, peachifySourceCapabilities)), false, 'C: the Android escape route (player tap disabling the sandbox) is impossible for Peachify');
ok(sandboxPolicyFromCapabilities(peachifyProviderCapabilities, peachifySourceCapabilities) !== 'unrestricted', 'C: Peachify is not unrestricted');
eq(playbackAdProtectionFromCapabilities(peachifyProviderCapabilities, peachifySourceCapabilities).enabled, false, 'C: Ad Protection remains OFF by default for Peachify');
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

console.log(`peachify_redirect_protection_test: ${passed} checks passed`);
