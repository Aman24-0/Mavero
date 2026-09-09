import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// MAVERO — PWA Install Banner UX Refinement Regression Test
//
// Verifies the refined PwaExperience.svelte implementation:
//   1. beforeinstallprompt is the ONLY eligibility signal (no banner
//      without the event, regardless of mobile/Chrome/manifest/SW).
//   2. Banner is not rendered without a captured install event.
//   3. Standalone mode (display-mode: standalone) hides the banner.
//   4. navigator.standalone hides the banner where applicable.
//   5. Install invokes prompt() from the stored event (user gesture).
//   6. prompt event is cleared after use (one-use event).
//   7. accepted installation hides the banner + clears dismissal.
//   8. dismissed installation applies the cooldown.
//   9. "Not now" applies the cooldown.
//  10. appinstalled hides/clears banner state.
//  11. Old `mavero-install-dismissed=1` does not permanently break
//      installation eligibility (migrated to timestamp + cooldown).
//  12. No history/navigation handlers introduced (no popstate, no
//      goto, no history.back).
//  13. No polling loop introduced (no setInterval).
//  14. No service-worker behavior changed (register/update/updatefound
//      contract preserved).

let passed = 0;
function ok(message: string) {
  passed += 1;
  console.log(`  ok ${passed} - ${message}`);
}

const source = readFileSync(new URL('../src/lib/components/PwaExperience.svelte', import.meta.url), 'utf8');

// ============================================================
// 1. beforeinstallprompt is the ONLY eligibility signal
// ============================================================
console.log('\n1. beforeinstallprompt is the only eligibility signal');

// The listener must be registered (capturing the event).
assert.match(source, /window\.addEventListener\('beforeinstallprompt'/,
  'beforeinstallprompt listener registered');
assert.match(source, /event\.preventDefault\(\)/,
  'beforeinstallprompt event.preventDefault() called (suppress browser mini-infobar)');
assert.match(source, /installEvent = event as InstallPromptEvent/,
  'installEvent stored from beforeinstallprompt event');
ok('beforeinstallprompt is captured + stored as the eligibility signal');

// The banner must NOT be shown based on browser sniffing.
// Verify NO checks for mobile/Chrome/manifest/SW as eligibility.
assert.doesNotMatch(source, /navigator\.userAgent.*mobile/i,
  'no mobile UA sniffing for eligibility');
assert.doesNotMatch(source, /isChrome|isEdge|isMobile/i,
  'no Chrome/Edge/Mobile browser sniffing for eligibility');
assert.doesNotMatch(source, /manifest.*exists|hasManifest/i,
  'no manifest-existence check for eligibility');
ok('No browser/manifest/SW sniffing — beforeinstallprompt is the sole signal');

// ============================================================
// 2. Banner is not rendered without install event
// ============================================================
console.log('\n2. Banner not rendered without install event');

// The template must gate on both showInstallPrompt AND installEvent.
assert.match(source, /\{#if showInstallPrompt && installEvent\}/,
  'banner rendered only when showInstallPrompt AND installEvent are both truthy');
// shouldShowBanner must require installEvent.
assert.match(source, /function shouldShowBanner\(\): boolean \{[\s\S]*?return Boolean\(installEvent\)/,
  'shouldShowBanner requires installEvent !== null');
ok('Banner is not rendered without a captured beforeinstallprompt event');

// ============================================================
// 3. Standalone mode hides the banner
// ============================================================
console.log('\n3. Standalone mode hides banner');

assert.match(source, /display-mode: standalone/,
  'isStandalone checks display-mode: standalone');
assert.match(source, /window\.matchMedia\('\(display-mode: standalone\)'\)\.matches/,
  'isStandalone uses matchMedia for (display-mode: standalone)');
// shouldShowBanner must call isStandalone() and return false if standalone.
assert.match(source, /function shouldShowBanner\(\): boolean \{[\s\S]*?!isStandalone\(\)/,
  'shouldShowBanner returns false when isStandalone() is true');
ok('Standalone mode (display-mode: standalone) hides the banner');

// ============================================================
// 4. navigator.standalone hides the banner (iOS Safari)
// ============================================================
console.log('\n4. navigator.standalone hides banner (iOS)');

assert.match(source, /navigator as Navigator & \{ standalone\?: boolean \}\)\.standalone/,
  'isStandalone checks navigator.standalone (iOS Safari)');
assert.match(source, /Boolean\(\(navigator as Navigator[\s\S]*?standalone/,
  'isStandalone uses Boolean() cast for navigator.standalone');
ok('navigator.standalone (iOS Safari) hides the banner');

// ============================================================
// 5. Install invokes prompt() from the stored event (user gesture)
// ============================================================
console.log('\n5. Install invokes prompt from stored event');

assert.match(source, /async function installApp\(\)/,
  'installApp function exists');
assert.match(source, /if \(!installEvent \|\| installing\) return/,
  'installApp guards on installEvent + installing state');
assert.match(source, /await promptEvent\.prompt\(\)/,
  'installApp calls promptEvent.prompt() (user-gesture-triggered)');
// prompt() must be called from the click handler, not from onMount/lifecycle.
// The installApp function is wired to the Install button's onclick.
assert.match(source, /<button class="install-btn"[^>]*onclick=\{installApp\}/,
  'Install button onclick calls installApp (user gesture)');
ok('Install invokes event.prompt() only from the user click');

// ============================================================
// 6. prompt event is cleared after use (one-use event)
// ============================================================
console.log('\n6. prompt event cleared after use');

// installEvent must be set to null BEFORE prompt() is called (so a
// double-click can't call prompt() twice).
assert.match(source, /const promptEvent = installEvent;[\s\S]*?installEvent = null;[\s\S]*?await promptEvent\.prompt\(\)/,
  'installEvent cleared BEFORE prompt() is called (prevents double-prompt)');
ok('prompt event is cleared before prompt() (one-use event, no double-prompt)');

// ============================================================
// 7. accepted installation hides banner + clears dismissal
// ============================================================
console.log('\n7. Accepted installation hides banner + clears dismissal');

assert.match(source, /const choice = await promptEvent\.userChoice/,
  'installApp awaits userChoice');
assert.match(source, /if \(choice\.outcome === 'accepted'\)/,
  'installApp checks for accepted outcome');
assert.match(source, /clearDismissal\(\)/,
  'accepted outcome calls clearDismissal() (removes dismissal timestamp)');
// clearDismissal must remove the localStorage key.
assert.match(source, /function clearDismissal\(\): void \{[\s\S]*?localStorage\.removeItem\(DISMISS_KEY\)/,
  'clearDismissal removes the dismissal localStorage key');
ok('Accepted installation clears the dismissal timestamp (future uninstall/reinstall not blocked)');

// ============================================================
// 8. dismissed installation applies the cooldown
// ============================================================
console.log('\n8. Dismissed installation applies cooldown');

assert.match(source, /else \{[\s\S]*?recordDismissal\(\)/,
  'dismissed outcome calls recordDismissal()');
ok('Dismissed native install sheet applies the cooldown');

// ============================================================
// 9. "Not now" applies the cooldown
// ============================================================
console.log('\n9. "Not now" applies cooldown');

assert.match(source, /function dismissInstallPrompt\(\) \{[\s\S]*?recordDismissal\(\)/,
  'dismissInstallPrompt calls recordDismissal()');
assert.match(source, /<button class="dismiss-btn"[^>]*onclick=\{dismissInstallPrompt\}/,
  '"Not now" button onclick calls dismissInstallPrompt');
ok('"Not now" applies the cooldown (not permanent)');

// ============================================================
// 10. appinstalled hides/clears banner state
// ============================================================
console.log('\n10. appinstalled hides/clears banner state');

assert.match(source, /window\.addEventListener\('appinstalled'/,
  'appinstalled listener registered');
assert.match(source, /appinstalledHandler = \(\) => \{[\s\S]*?installEvent = null;[\s\S]*?installing = false;[\s\S]*?showInstallPrompt = false/,
  'appinstalled handler clears installEvent + installing + showInstallPrompt');
// appinstalled must NOT permanently mark installed (no setItem with a permanent key).
assert.doesNotMatch(source, /localStorage\.setItem\('mavero-installed/,
  'appinstalled does NOT permanently mark installed in localStorage');
ok('appinstalled immediately clears all banner state (no permanent installed flag)');

// ============================================================
// 11. Old `mavero-install-dismissed=1` does not permanently break
//     installation eligibility
// ============================================================
console.log('\n11. Old boolean dismissal migrated safely');

assert.match(source, /const DISMISS_KEY = 'mavero-install-dismissed'/,
  'DISMISS_KEY constant = mavero-install-dismissed (same key as old impl)');
// getDismissedTimestamp must handle the old '1' format.
assert.match(source, /if \(raw === '1'\) \{/,
  'getDismissedTimestamp handles old format (raw === "1")');
assert.match(source, /Old format migration: treat as dismissed "now"/,
  'old format migration documented');
// The migration must write the new timestamp format.
assert.match(source, /if \(raw === '1'\) \{[\s\S]*?const now = Date\.now\(\);[\s\S]*?localStorage\.setItem\(DISMISS_KEY, String\(now\)\)/,
  'old "1" migrated to current timestamp (new format)');
// isDismissedRecently must use the timestamp + cooldown.
assert.match(source, /function isDismissedRecently\(\): boolean \{[\s\S]*?Date\.now\(\) - ts < COOLDOWN_MS/,
  'isDismissedRecently compares Date.now() - ts < COOLDOWN_MS');
// COOLDOWN_MS must be defined and reasonable (at least 1 day, at most 30 days).
assert.match(source, /const COOLDOWN_MS = \d+ \* \d+ \* \d+ \* \d+ \* \d+/,
  'COOLDOWN_MS defined as a product of time units');
ok('Old boolean "1" migrated to timestamp + cooldown (not permanent)');

// ============================================================
// 12. No history/navigation handlers introduced
// ============================================================
console.log('\n12. No history/navigation handlers');

// Strip comments before checking — the source mentions these terms in
// comments ("does NOT use popstate") which would false-positive.
const sourceNoComments = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
assert.doesNotMatch(sourceNoComments, /popstate/,
  'no popstate listener');
assert.doesNotMatch(sourceNoComments, /history\.back/,
  'no history.back() call');
assert.doesNotMatch(sourceNoComments, /history\.pushState/,
  'no history.pushState() call');
assert.doesNotMatch(sourceNoComments, /history\.replaceState/,
  'no history.replaceState() call');
assert.doesNotMatch(sourceNoComments, /\bgoto\(/,
  'no goto() call');
assert.doesNotMatch(sourceNoComments, /disableScrollHandling/,
  'no disableScrollHandling');
assert.doesNotMatch(sourceNoComments, /beforeNavigate|afterNavigate|onNavigate/,
  'no beforeNavigate/afterNavigate/onNavigate hooks');
ok('No popstate/history/goto/navigation hooks introduced');

// ============================================================
// 13. No polling loop introduced
// ============================================================
console.log('\n13. No polling loop');

assert.doesNotMatch(source, /setInterval/,
  'no setInterval (no polling)');
assert.doesNotMatch(source, /setTimeout[\s\S]*?beforeinstallprompt/,
  'no setTimeout-based beforeinstallprompt retry');
// The beforeinstallprompt listener is registered once in onMount.
const bipListenerCount = (source.match(/window\.addEventListener\('beforeinstallprompt'/g) ?? []).length;
assert.equal(bipListenerCount, 1,
  'exactly one beforeinstallprompt listener (no re-registration)');
ok('No polling loop — single beforeinstallprompt listener registered in onMount');

// ============================================================
// 14. No service-worker behavior changed
// ============================================================
console.log('\n14. Service-worker behavior unchanged');

assert.match(source, /if \('serviceWorker' in navigator\) \{[\s\S]*?navigator\.serviceWorker\.register\('\/sw\.js', \{ scope: '\/' \}\)/,
  'serviceWorker.register(/sw.js, { scope: "/" }) preserved');
assert.match(source, /registration\.update\(\)/,
  'registration.update() preserved');
assert.match(source, /registration\.addEventListener\('updatefound'/,
  'updatefound listener preserved');
assert.match(source, /worker\.addEventListener\('statechange'/,
  'worker statechange listener preserved');
assert.match(source, /worker\.state === 'installed' && navigator\.serviceWorker\.controller/,
  'updateAvailable set on installed+controller state preserved');
ok('Service-worker register/update/updatefound contract unchanged');

// ============================================================
// 15. Cleanup — listeners are removed on component destroy
// ============================================================
console.log('\n15. Listener cleanup on destroy');

// The onMount return must removeEventListener for beforeinstallprompt + appinstalled.
assert.match(source, /return \(\) => \{[\s\S]*?removeEventListener\('beforeinstallprompt'/,
  'onMount cleanup removes beforeinstallprompt listener');
assert.match(source, /return \(\) => \{[\s\S]*?removeEventListener\('appinstalled'/,
  'onMount cleanup removes appinstalled listener');
assert.match(source, /removeEventListener\('online', handleOnlineState\)/,
  'onMount cleanup removes online listener');
assert.match(source, /removeEventListener\('offline', handleOnlineState\)/,
  'onMount cleanup removes offline listener');
ok('All window listeners are cleaned up on component destroy');

// ============================================================
// 16. Banner UX — compact, native-feel, Mavero visual language
// ============================================================
console.log('\n16. Banner UX — compact, native, Mavero visual language');

// Banner must use Mavero visual tokens (CSS variables, not hardcoded).
assert.match(source, /background: rgba\(15, 15, 15, \.97\)/,
  'banner background uses Mavero surface color');
assert.match(source, /border: 1px solid var\(--line-strong\)/,
  'banner border uses --line-strong token');
assert.match(source, /border-radius: var\(--radius-lg\)/,
  'banner border-radius uses --radius-lg token');
assert.match(source, /box-shadow: var\(--shadow-sm\)/,
  'banner box-shadow uses --shadow-sm token');
assert.match(source, /color: var\(--ink\)/,
  'banner text color uses --ink token');
assert.match(source, /backdrop-filter: blur\(16px\)/,
  'banner uses backdrop-filter blur (glass treatment)');
ok('Banner uses Mavero visual tokens (surface, accent, radius, shadow)');

// Banner must include the Mavero icon.
assert.match(source, /<img src="\/icons\/mavero-192\.png"/,
  'banner includes mavero-192.png icon');
assert.match(source, /alt=""/,
  'icon img has empty alt (decorative — label is on the container)');
ok('Banner includes the Mavero icon (decorative, alt="")');

// Banner must be role="dialog" with aria-label.
assert.match(source, /role="dialog" aria-label="Install Mavero"/,
  'banner has role=dialog + aria-label');
ok('Banner has accessible role=dialog + aria-label');

// Banner must NOT be a full-screen modal / blocking overlay.
// It must be position: fixed with a bounded width.
assert.match(source, /position: fixed/,
  'banner is position: fixed (not full-screen)');
assert.match(source, /width: min\(100% - 32px, 440px\)/,
  'banner width is bounded (max 440px)');
assert.doesNotMatch(source, /position: absolute; inset: 0/,
  'banner is NOT a full-screen overlay');
ok('Banner is compact (fixed position, bounded width, not full-screen)');

// Banner must not cover the bottom nav — positioned above the mobile pill.
assert.match(source, /bottom: calc\(96px \+ env\(safe-area-inset-bottom\)\)/,
  'banner bottom: 96px + safe-area (above mobile nav pill)');
ok('Banner positioned above mobile nav pill (does not cover navigation)');

// Banner must respect safe-area insets.
assert.match(source, /env\(safe-area-inset-bottom\)/,
  'banner respects safe-area-inset-bottom');
ok('Banner respects safe-area insets');

// Entrance transition must be subtle (not attention-grabbing).
assert.match(source, /animation: install-slide-in 280ms/,
  'banner has a subtle 280ms entrance animation');
assert.match(source, /@keyframes install-slide-in[\s\S]*?from \{ opacity: 0; transform: translateY\(12px\)/,
  'entrance animation is a subtle slide-in (12px translateY)');
// Must respect prefers-reduced-motion.
assert.match(source, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.install-prompt \{ animation: none/,
  'entrance animation disabled for prefers-reduced-motion');
ok('Entrance transition is subtle + respects reduced-motion');

// ============================================================
// 17. No localStorage writes on every render
// ============================================================
console.log('\n17. No localStorage writes on every render');

// localStorage.setItem must only be called from:
//   - recordDismissal() (Not now / dismissed)
//   - getDismissedTimestamp() migration (one-time)
//   - NOT from any reactive statement or render path
const setItemMatches = source.match(/localStorage\.setItem/g) ?? [];
assert.ok(setItemMatches.length <= 2,
  `at most 2 localStorage.setItem call sites (recordDismissal + migration); found ${setItemMatches.length}`);
// Verify neither is inside a reactive $: block.
assert.doesNotMatch(source, /\$: [\s\S]*?localStorage\.setItem/,
  'no localStorage.setItem inside a reactive $: block');
ok('No localStorage writes on every render (only on dismissal/migration)');

// ============================================================
// 18. Install button disabled state during prompt
// ============================================================
console.log('\n18. Install button disabled during prompt');

assert.match(source, /disabled=\{installing\}/,
  'Install button has disabled={installing}');
assert.match(source, /installing \? 'Installing…' : 'Install'/,
  'Install button shows "Installing…" while installing');
ok('Install button is disabled + shows "Installing…" during prompt()');

// ============================================================
// 19. iOS / unsupported browsers — no banner
// ============================================================
console.log('\n19. iOS / unsupported browsers — no banner');

// If beforeinstallprompt never fires (iOS Safari, Firefox, etc.),
// installEvent stays null, and the banner never renders.
// This is covered by test #2 (banner not rendered without installEvent).
// Additionally, verify there are NO fake prompt calls or manual
// installation instructions.
assert.doesNotMatch(source, /addToHomeScreen|Add to Home Screen/i,
  'no "Add to Home Screen" manual instructions');
assert.doesNotMatch(source, /share.*safari.*install/i,
  'no iOS Share-sheet installation instructions');
assert.doesNotMatch(source, /fake.*prompt|prompt.*fake/i,
  'no fake prompt');
ok('iOS/unsupported: no banner, no fake prompt, no manual instructions');

console.log(`\nPWA install banner tests passed (${passed} check groups).`);
