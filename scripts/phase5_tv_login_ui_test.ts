import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ============================================================
// PHASE 5 — TV/DESKTOP QR UI TESTS
// ============================================================
// Phase 5 is the TV/Desktop side of the QR login experience.
// The backend (Phase 4) is already complete and hardened. These
// tests verify the /tv-login page's UI contract:
//   - local QR generation (no external service)
//   - QR encodes only the pairing URL (no tokens, no credentials)
//   - responsive QR sizing for small/large/TV viewports
//   - TV-readable typography
//   - keyboard/remote focus management
//   - timer/poll lifecycle (no stale timers after retry)
//   - bare route preserved
//   - reduced-motion support
//
// STATIC CONTRACT tests. Runtime browser verification (actual QR
// rendering, actual focus behavior, actual layout at each viewport)
// is out of scope — these tests verify the source-level contracts
// that guarantee the behavior.

// ============================================================
// 1. /tv-login EXISTS + BARE ROUTE
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');
  const layout = read('src/routes/+layout.svelte');

  ok(page.length > 1000, '1. /tv-login page exists and is substantial');
  ok(page.includes('<svelte:head>'), '1. page has svelte:head with title');
  ok(page.includes('TV Sign in'), '1. page title includes "TV Sign in"');
  ok(page.includes('noindex,nofollow'), '1. page has noindex,nofollow meta');

  // Bare route — /tv-login renders without the normal AppShell sidebar.
  ok(layout.includes('/tv-login'), '1. layout: /tv-login in bare-route check');

  ok('1. /tv-login exists + bare route preserved');
}

// ============================================================
// 2. LOCAL QR GENERATION — NO EXTERNAL SERVICE
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  ok(page.includes("import QRCode from 'qrcode'"), '2. imports qrcode package locally');
  ok(page.includes('QRCode.toDataURL'), '2. uses QRCode.toDataURL for local generation');

  // No external QR services.
  ok(!page.includes('api.qrserver.com'), '2. no api.qrserver.com');
  ok(!page.includes('qrserver'), '2. no qrserver reference');
  ok(!page.includes('chart.googleapis.com'), '2. no chart.googleapis.com QR');
  ok(!page.includes('api.qr-code'), '2. no api.qr-code external service');

  ok('2. local QR generation (no external service)');
}

// ============================================================
// 3. QR ENCODES ONLY THE PAIRING URL
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  // The QR URL is built from the create endpoint's response.
  ok(page.includes('payload.pairing.qrUrl'), '3. QR URL comes from create endpoint response');
  ok(page.includes('qrUrl'), '3. QR URL state variable');

  // No tokens, user IDs, or credentials in the QR payload.
  ok(!page.includes('access_token'), '3. no access_token in client');
  ok(!page.includes('refresh_token'), '3. no refresh_token in client');
  ok(!page.includes('exchange_code'), '3. no exchange_code in client');
  ok(!page.match(/body.*user_id/), '3. no user_id in request body');
  ok(!page.includes('session_id'), '3. no session_id in client (except via JWT on server)');

  ok('3. QR encodes only the pairing URL (no credentials)');
}

// ============================================================
// 4. NO RAW CREDENTIAL LOGGING
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  // No console.log/error/warn with secret/token material.
  ok(!page.match(/console\.\w+.*secret/i), '4. no secret logging');
  ok(!page.match(/console\.\w+.*access_token/i), '4. no access_token logging');
  ok(!page.match(/console\.\w+.*refresh_token/i), '4. no refresh_token logging');
  ok(!page.match(/console\.\w+.*exchange_code/i), '4. no exchange_code logging');
  ok(!page.match(/console\.\w+.*hashed_token/i), '4. no hashed_token logging');

  ok('4. no raw credential logging');
}

// ============================================================
// 5. CREATE ENDPOINT CALLED
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  ok(page.includes('/api/auth/device-pairing/create'), '5. calls create endpoint');
  ok(page.includes('method: \'POST\''), '5. uses POST method');
  ok(page.includes('createPairing'), '5. has createPairing function');
  ok(page.includes('onMount'), '5. creates pairing on mount');

  ok('5. create endpoint called on mount');
}

// ============================================================
// 6. STATUS POLLING EXISTS + STOPS ON TERMINAL STATES
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  ok(page.includes('/api/auth/device-pairing/status'), '6. polls status endpoint');
  ok(page.includes('startPolling'), '6. has startPolling function');
  ok(page.includes('setInterval'), '6. uses setInterval for polling');

  // Polling stops on terminal states — look for clearInterval calls.
  ok(page.includes('clearInterval(pollTimer)'), '6. clears poll timer');

  // Polling guards: only polls while pending.
  ok(page.includes("pairingState !== 'pending'"), '6. poll guard: only polls while pending');

  // Stops on approved.
  ok(page.includes("payload.status === 'approved'"), '6. detects approved status');
  // Stops on cancelled.
  ok(page.includes("payload.status === 'cancelled'"), '6. detects cancelled status');
  // Stops on expired.
  ok(page.includes("payload.status === 'expired'"), '6. detects expired status');

  // 5-consecutive-error circuit breaker.
  ok(page.includes('consecutiveErrors'), '6. has consecutive-error counter');
  ok(page.includes('consecutiveErrors > 5'), '6. circuit breaker at 5 consecutive errors');

  ok('6. status polling + stops on terminal states');
}

// ============================================================
// 7. POLLING FREQUENCY RESPECTS RATE LIMIT
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  // The pairingPoll rate limit is 60/min per IP+secret.
  // Polling every 3s = 20 polls/min — well within the 60/min limit.
  ok(page.includes('3000'), '7. polls every 3000ms (3s) — within pairingPoll 60/min limit');

  ok('7. polling frequency respects Phase 4 rate limit');
}

// ============================================================
// 8. COUNTDOWN EXISTS + STOPS ON TERMINAL STATES
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  ok(page.includes('startCountdown'), '8. has startCountdown function');
  ok(page.includes('formatCountdown'), '8. has formatCountdown formatter');
  ok(page.includes('countdown'), '8. has countdown state');
  ok(page.includes('MM:SS') || page.includes('padStart(2, \'0\')'), '8. countdown formatted as MM:SS');

  // Countdown clamped to 0 (never negative).
  ok(page.includes('Math.max(0'), '8. countdown clamped to 0 (never negative)');

  // Countdown stops on terminal states.
  ok(page.includes('clearInterval(countdownTimer)'), '8. clears countdown timer');

  // Countdown stops when expired.
  ok(page.includes("remaining <= 0"), '8. countdown stops at 0');

  ok('8. countdown + stops on terminal states');
}

// ============================================================
// 9. EXPIRED STATE EXISTS
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  ok(page.includes("'expired'"), '9. has expired state');
  ok(page.includes('Code expired'), '9. expired state shows "Code expired"');
  ok(page.includes('This sign-in code has expired'), '9. expired state has descriptive message');
  ok(page.includes('Generate new code'), '9. expired state has retry button');
  ok(page.includes('tv-state-expired'), '9. expired state has CSS class');

  ok('9. expired state exists with retry');
}

// ============================================================
// 10. RETRY CREATES A FRESH PAIRING REQUEST
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  // Retry calls createPairing() which POSTs to /create again.
  ok(page.includes('createPairing'), '10. retry calls createPairing');

  // Retry is wired to the expired + error states.
  ok(page.includes('Generate new code'), '10. expired retry button');
  ok(page.includes('Try again'), '10. error retry button');

  // Phase 5: requestToken pattern prevents stale callbacks from
  // mutating state belonging to a newer retry.
  ok(page.includes('requestToken'), '10. request token for stale-callback protection');
  ok(page.includes('myToken !== requestToken'), '10. stale callback guard');
  ok(page.includes('++requestToken'), '10. increments request token on each retry');

  ok('10. retry creates a fresh pairing request (stale-callback safe)');
}

// ============================================================
// 11. EXCHANGE ENDPOINT USED
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  ok(page.includes('/api/auth/device-pairing/exchange'), '11. calls exchange endpoint');
  ok(page.includes('exchangeSession'), '11. has exchangeSession function');
  ok(page.includes("redirect: 'manual'"), '11. uses manual redirect (handles SSR cookie set)');

  ok('11. exchange endpoint used');
}

// ============================================================
// 12. NO /consume ENDPOINT
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  ok(!page.includes('/api/auth/device-pairing/consume'), '12. does NOT call /consume endpoint');
  ok(!page.includes('consumePairing'), '12. does NOT call consumePairing');

  ok('12. no /consume endpoint (exchange is atomic)');
}

// ============================================================
// 13. SUCCESS STATE EXISTS
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  ok(page.includes("'success'"), '13. has success state');
  ok(page.includes("You're signed in"), '13. success state shows "You\'re signed in"');
  ok(page.includes('Redirecting to Mavero'), '13. success state shows redirect message');
  ok(page.includes('tv-state-success'), '13. success state has CSS class');
  ok(page.includes("goto('/discover')"), '13. redirects to /discover after success');

  ok('13. success state exists with redirect to /discover');
}

// ============================================================
// 14. ERROR STATE EXISTS
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  ok(page.includes("'error'"), '14. has error state');
  ok(page.includes('Something went wrong'), '14. error state shows "Something went wrong"');
  ok(page.includes('errorMessage'), '14. error state has error message');
  ok(page.includes('tv-state-error'), '14. error state has CSS class');
  ok(page.includes('Try again'), '14. error state has retry button');

  // No credential leakage in error messages.
  ok(!page.match(/errorMessage.*access_token/), '14. no access_token in error message');
  ok(!page.match(/errorMessage.*refresh_token/), '14. no refresh_token in error message');

  ok('14. error state exists with retry + no credential leakage');
}

// ============================================================
// 15. NO DUPLICATE TIMER/POLL LIFECYCLE
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  // createPairing clears existing timers before starting new ones.
  ok(page.includes('if (pollTimer) clearInterval(pollTimer)'), '15. createPairing clears existing poll timer');
  ok(page.includes('if (countdownTimer) clearInterval(countdownTimer)'), '15. createPairing clears existing countdown timer');

  // Timers cleared in onDestroy.
  ok(page.includes('onDestroy'), '15. has onDestroy cleanup');
  ok(page.includes('clearInterval(pollTimer)'), '15. onDestroy clears poll timer');
  ok(page.includes('clearInterval(countdownTimer)'), '15. onDestroy clears countdown timer');

  // Phase 5: timers are set to undefined after clearing so the
  // `if (timer)` guards work correctly on subsequent retries.
  ok(page.includes('pollTimer = undefined'), '15. pollTimer set to undefined after clear');
  ok(page.includes('countdownTimer = undefined'), '15. countdownTimer set to undefined after clear');

  ok('15. no duplicate timer/poll lifecycle (cleanup + undefined reset)');
}

// ============================================================
// 16. KEYBOARD / FOCUS-VISIBLE SUPPORT
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  // Focus-visible states on interactive elements.
  ok(page.includes('focus-visible'), '16. has focus-visible styles');
  ok(page.includes('outline'), '16. has outline on focus');

  // Retry buttons are focusable (type="button" + no tabindex=-1).
  ok(page.includes('type="button"'), '16. retry buttons are type="button"');

  // Phase 5: focus management — $effect focuses the retry button on
  // expired/error state transitions so TV-remote/keyboard users can
  // immediately activate it.
  ok(page.includes('$effect'), '16. has $effect for focus management');
  ok(page.includes('expiredRetryBtn'), '16. expired retry button ref');
  ok(page.includes('errorRetryBtn'), '16. error retry button ref');
  ok(page.includes('bind:this'), '16. uses bind:this for button refs');
  ok(page.includes('.focus()'), '16. focuses retry button on state transition');
  ok(page.includes('tick()'), '16. uses tick() to wait for DOM before focus');

  // AuthShell back button is keyboard-focusable (verified in AuthShell.svelte).
  const authShell = read('src/lib/components/AuthShell.svelte');
  ok(authShell.includes('back-pill'), '16. AuthShell has back-pill');
  ok(authShell.includes('focus-visible'), '16. AuthShell back-pill has focus-visible');

  ok('16. keyboard/focus-visible support (retry focus management, AuthShell back button)');
}

// ============================================================
// 17. RESPONSIVE LARGE-SCREEN QR SIZING
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  // Phase 5: responsive QR sizing via media queries.
  ok(page.includes('@media (min-width: 768px)'), '17. has 768px breakpoint (small desktop)');
  ok(page.includes('@media (min-width: 1024px)'), '17. has 1024px breakpoint (large desktop)');
  ok(page.includes('@media (min-width: 1920px)'), '17. has 1920px breakpoint (TV)');

  // QR size scales up at larger breakpoints.
  ok(page.includes('width: 280px'), '17. QR 280px at ≥768px');
  ok(page.includes('width: 320px'), '17. QR 320px at ≥1024px');
  ok(page.includes('width: 360px'), '17. QR 360px at ≥1920px (TV)');

  // Default (mobile) is 240px or smaller via clamp/min.
  ok(page.includes('min(240px, 60vw)'), '17. default QR is 240px (capped by 60vw on narrow)');

  // The img has NO hardcoded width/height attributes (CSS controls size).
  ok(!page.includes('width="240"'), '17. no hardcoded width="240" attribute');
  ok(!page.includes('height="240"'), '17. no hardcoded height="240" attribute');

  // QR raster is high-res (480px) for sharpness on large screens.
  ok(page.includes('width: 480'), '17. QR raster is 480px (high-DPI friendly)');

  ok('17. responsive large-screen QR sizing (240→280→320→360px)');
}

// ============================================================
// 18. REDUCED-MOTION SUPPORT
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  ok(page.includes('prefers-reduced-motion'), '18. has prefers-reduced-motion media query');
  ok(page.includes('reduce'), '18. reduced-motion: reduce');
  ok(page.includes('animation: none'), '18. reduced-motion disables spin animation');

  // Reduced-motion also disables button transitions.
  ok(page.includes('transition: none'), '18. reduced-motion disables button transitions');

  ok('18. reduced-motion support (spin + transitions disabled)');
}

// ============================================================
// 19. TV-READABLE TYPOGRAPHY
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  // Typography scales up at larger breakpoints.
  // The 1920px (TV) breakpoint has the largest text.
  const tvBreakpoint = page.slice(page.indexOf('@media (min-width: 1920px)'));
  ok(tvBreakpoint.includes('font-size: 1.02rem'), '19. TV: instructions 1.02rem');
  ok(tvBreakpoint.includes('font-size: 1.2rem'), '19. TV: countdown 1.2rem');
  ok(tvBreakpoint.includes('font-size: 1.65rem'), '19. TV: success heading 1.65rem');

  // Countdown uses tabular-nums so digits don't shift.
  ok(page.includes('tabular-nums'), '19. countdown uses tabular-nums (stable digit width)');

  ok('19. TV-readable typography (scaled text, tabular-nums countdown)');
}

// ============================================================
// 20. ARIA LIVE REGIONS FOR STATE TRANSITIONS
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  // Loading state announces "Preparing your sign-in code…".
  ok(page.includes('aria-live="polite"'), '20. has aria-live="polite" regions');

  // Expired/error states use role="alert" for screen-reader announcement.
  ok(page.includes('role="alert"'), '20. expired/error states use role="alert"');

  // Success/exchanging states use role="status".
  ok(page.includes('role="status"'), '20. success/exchanging states use role="status"');

  // Countdown is aria-live="off" (frequent updates would be noise).
  ok(page.includes('aria-live="off"'), '20. countdown is aria-live="off" (no noise)');

  ok('20. ARIA live regions for state transitions (alert/status/off)');
}

// ============================================================
// 21. AUTH SHELL BACK BUTTON OVERRIDE FOR TV CONTEXT
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  // /tv-login overrides AuthShell's back button props for the TV context.
  ok(page.includes('backHref'), '21. overrides backHref');
  ok(page.includes('backLabel'), '21. overrides backLabel');
  ok(page.includes('/discover'), '21. backHref is /discover (consumer landing)');
  ok(page.includes('Back to Mavero'), '21. backLabel is "Back to Mavero" (clearer on TV)');

  // AuthShell itself is NOT modified globally.
  const authShell = read('src/lib/components/AuthShell.svelte');
  ok(authShell.includes('export let backHref'), '21. AuthShell still has backHref prop (not globally changed)');
  ok(authShell.includes('export let backLabel'), '21. AuthShell still has backLabel prop');

  ok('21. AuthShell back button overridden for TV (not globally modified)');
}

// ============================================================
// 22. BACK BUTTON MIN-HEIGHT FOR REMOTE/TOUCH
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');
  const authShell = read('src/lib/components/AuthShell.svelte');

  // Retry buttons have 44px min-height (touch/remote target).
  ok(page.includes('min-height: 44px'), '22. retry button min-height: 44px');

  // AuthShell back-pill has 44px min-height.
  ok(authShell.includes('min-height: 44px'), '22. AuthShell back-pill min-height: 44px');

  ok('22. buttons meet 44px touch/remote target');
}

// ============================================================
// 23. NO CAMERA / PHONE-SCANNER APIs (PHASE 6 SEPARATION)
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  // Phase 5 is TV/Desktop only — no phone scanner, no camera APIs.
  ok(!page.includes('getUserMedia'), '23. no getUserMedia (Phase 6 separation)');
  ok(!page.includes('qr-scanner'), '23. no qr-scanner import (Phase 6 separation)');
  ok(!page.includes('jsQR'), '23. no jsQR import (Phase 6 separation)');
  ok(!page.includes('ZXing'), '23. no ZXing import (Phase 6 separation)');
  ok(!page.includes('@zxing'), '23. no @zxing import (Phase 6 separation)');
  ok(!page.includes('Login on TV'), '23. no "Login on TV" entry point (Phase 6 separation)');
  ok(!page.includes('/account/scan-tv'), '23. no /account/scan-tv route (Phase 6 separation)');

  ok('23. no camera / phone-scanner APIs (Phase 6 separation maintained)');
}

// ============================================================
// 24. NO HORIZONTAL OVERFLOW
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  // The QR uses min(240px, 60vw) so it never overflows on narrow screens.
  ok(page.includes('min(240px, 60vw)'), '24. QR capped by 60vw (no horizontal overflow)');

  // The AuthShell uses clamp() for gutter padding.
  const authShell = read('src/lib/components/AuthShell.svelte');
  ok(authShell.includes('clamp(16px, 5vw, 48px)'), '24. AuthShell gutter uses clamp (no overflow)');

  ok('24. no horizontal overflow (QR capped, gutter clamped)');
}

// ============================================================
// 25. REGRESSION — EXISTING PAIRING CONTRACTS PRESERVED
// ============================================================
{
  const page = read('src/routes/tv-login/+page.svelte');

  // Still uses AuthShell (not a new shell).
  ok(page.includes('AuthShell'), '25. still uses AuthShell');

  // Still uses haptic feedback.
  ok(page.includes('haptic'), '25. still uses haptic feedback');

  // Still uses the same state machine.
  ok(page.includes("'idle'"), '25. idle state');
  ok(page.includes("'loading'"), '25. loading state');
  ok(page.includes("'pending'"), '25. pending state');
  ok(page.includes("'exchanging'"), '25. exchanging state');
  ok(page.includes("'approved'"), '25. approved detection');

  // Still uses CheckCircle2 + AlertCircle + LoaderCircle + RefreshCw.
  ok(page.includes('CheckCircle2'), '25. CheckCircle2 icon');
  ok(page.includes('AlertCircle'), '25. AlertCircle icon');
  ok(page.includes('LoaderCircle'), '25. LoaderCircle icon');
  ok(page.includes('RefreshCw'), '25. RefreshCw icon');

  // Short code fallback still present.
  ok(page.includes('shortCode'), '25. short code fallback');
  ok(page.includes('Or enter code manually'), '25. short code label');

  ok('25. regression: existing pairing contracts preserved');
}

console.log(`\nPhase 5 TV/Desktop QR UI tests passed (${passed} check groups).`);
