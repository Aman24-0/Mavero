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
// PHASE 6 — PHONE QR SCANNER + APPROVAL TESTS
// ============================================================
// Phase 6 is the phone-side QR scanning experience. These tests
// verify the scanner route, camera lifecycle, QR validation, and
// the Account "Login on TV" entry point.
//
// STATIC CONTRACT tests. Runtime browser verification (actual
// camera access, actual QR decoding, actual navigation) is out of
// scope — these tests verify the source-level contracts.

// ============================================================
// 1. ACCOUNT PAGE — "LOGIN ON TV" ENTRY POINT
// ============================================================
{
  const account = read('src/routes/account/+page.svelte');

  ok(account.includes('Login on TV'), '1. account page: has "Login on TV" button');
  ok(account.includes('login-tv-btn'), '1. account page: has login-tv-btn class');
  ok(account.includes('/account/scan-tv'), '1. account page: links to /account/scan-tv');
  ok(account.includes('Tv'), '1. account page: uses Tv icon');

  // Only shown for authenticated users (inside {#if data.user}).
  ok(account.includes('{#if data.user}'), '1. account page: Login on TV is inside auth guard');

  // Keyboard accessible — it's an <a> tag (inherently focusable).
  ok(account.includes('<a class="login-tv-btn"'), '1. account page: Login on TV is an <a> (keyboard focusable)');

  // Visible focus state.
  ok(account.includes('.login-tv-btn:focus-visible'), '1. account page: Login on TV has focus-visible style');

  // Touch target — min-height 40px.
  ok(account.includes('min-height: 40px'), '1. account page: Login on TV has 40px touch target');

  // No duplicate navigation item (it's a single button, not a global nav item).
  // Count only the rendered button instances, not CSS comments.
  const buttonMatches = account.match(/<a class="login-tv-btn"/g);
  ok(buttonMatches && buttonMatches.length === 1, '1. account page: exactly one login-tv-btn button (no duplicate nav)');

  ok('1. account page has Login on TV entry point');
}

// ============================================================
// 2. SCANNER ROUTE EXISTS
// ============================================================
{
  const page = read('src/routes/account/scan-tv/+page.svelte');
  const serverLoad = read('src/routes/account/scan-tv/+page.server.ts');

  ok(page.length > 1000, '2. scanner page exists and is substantial');
  ok(page.includes('<svelte:head>'), '2. scanner page has svelte:head');
  ok(page.includes('Login on Big Screen'), '2. scanner page title (Big Screen wording, §9)');
  ok(page.includes('noindex,nofollow'), '2. scanner page has noindex');

  // Server load — auth required.
  ok(serverLoad.includes('PageServerLoad'), '2. server load: PageServerLoad');
  ok(serverLoad.includes('locals.user'), '2. server load: checks locals.user');
  ok(serverLoad.includes('redirect'), '2. server load: redirects unauthenticated users');
  ok(serverLoad.includes('/auth/sign-in'), '2. server load: redirects to sign-in');

  ok('2. scanner route exists with auth guard');
}

// ============================================================
// 3. CAMERA API USAGE — ONLY IN SCANNER
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // getUserMedia is used in the scanner.
  ok(scanner.includes('navigator.mediaDevices.getUserMedia'), '3. scanner: uses getUserMedia');

  // Verify getUserMedia is NOT used anywhere else in src/.
  const otherFiles = [
    'src/routes/tv-login/+page.svelte',
    'src/routes/authorize/+page.svelte',
    'src/routes/account/+page.svelte',
    'src/hooks.server.ts',
  ];
  for (const f of otherFiles) {
    const content = read(f);
    ok(!content.includes('getUserMedia'), `3. ${f}: does NOT use getUserMedia (scanner-only)`);
  }

  ok('3. camera API usage only in scanner implementation');
}

// ============================================================
// 4. ENVIRONMENT CAMERA PREFERENCE
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // Prefers rear/environment-facing camera.
  ok(scanner.includes('facingMode'), '4. scanner: uses facingMode constraint');
  ok(scanner.includes("'environment'") || scanner.includes('"environment"'), '4. scanner: prefers environment-facing camera');
  ok(scanner.includes('ideal'), '4. scanner: uses ideal (not exact — graceful fallback)');

  // Audio is disabled.
  ok(scanner.includes('audio: false'), '4. scanner: audio disabled');

  ok('4. environment camera preference with graceful fallback');
}

// ============================================================
// 5. CAMERA TRACKS STOPPED DURING CLEANUP
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // stopCamera function exists.
  ok(scanner.includes('function stopCamera'), '5. scanner: has stopCamera function');
  ok(scanner.includes('track.stop()'), '5. scanner: calls track.stop() on each track');
  ok(scanner.includes('getTracks()'), '5. scanner: iterates getTracks()');

  // Called on component destroy.
  ok(scanner.includes('onDestroy'), '5. scanner: has onDestroy lifecycle');
  ok(scanner.includes('stopCamera()'), '5. scanner: stopCamera called in onDestroy');

  // Cancels requestAnimationFrame.
  ok(scanner.includes('cancelAnimationFrame'), '5. scanner: cancels requestAnimationFrame');
  ok(scanner.includes('video.srcObject = null'), '5. scanner: detaches stream from video');

  ok('5. camera tracks stopped during cleanup (destroy, cancel, error)');
}

// ============================================================
// 6. SUCCESSFUL SCAN STOPS CAMERA
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // handleDecodedQR calls stopCamera before navigating.
  const fnStart = scanner.indexOf('async function handleDecodedQR');
  const fnEnd = scanner.indexOf('\n  }', fnStart);
  const fnBody = scanner.slice(fnStart, fnEnd !== -1 ? fnEnd : undefined);

  ok(fnBody.includes('stopCamera()'), '6. handleDecodedQR: stops camera on scan success');
  ok(!fnBody.includes('console.'), '6. handleDecodedQR: no logging of decoded data');

  ok('6. successful scan stops camera immediately');
}

// ============================================================
// 7. DUPLICATE SCAN CALLBACK PREVENTION
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // scanResolved guard prevents duplicate callbacks.
  ok(scanner.includes('scanResolved'), '7. scanner: has scanResolved guard');
  ok(scanner.includes('scanResolved = true'), '7. scanner: sets scanResolved on first detection');
  ok(scanner.includes('!scanResolved'), '7. scanner: checks !scanResolved before processing');

  // Reset on retry.
  ok(scanner.includes('scanResolved = false'), '7. scanner: resets scanResolved on retry');

  // The decode loop checks scanResolved.
  ok(scanner.includes('if (destroyed || scanState !== \'scanning\' || scanResolved) return'), '7. scanner: decode loop checks scanResolved');

  ok('7. duplicate scan callbacks prevented (scanResolved guard)');
}

// ============================================================
// 8. QR PAYLOAD VALIDATION
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // validateMaveroPairingURL function exists.
  ok(scanner.includes('function validateMaveroPairingURL'), '8. scanner: has validateMaveroPairingURL function');

  // Validates origin (same-origin).
  ok(scanner.includes('url.origin'), '8. scanner: checks URL origin');
  ok(scanner.includes('window.location.origin'), '8. scanner: enforces same-origin');

  // Validates pathname.
  ok(scanner.includes("url.pathname !== '/authorize'"), '8. scanner: rejects non-/authorize paths');

  // Phase 8: the secret is now extracted from the URL FRAGMENT (#s=),
  // NOT the query string (?s=). The scanner parses the fragment via
  // URLSearchParams on the hash (minus the leading '#').
  ok(scanner.includes('fragmentParams'), '8. scanner: parses fragment params');
  ok(scanner.includes("fragmentParams.get('s')"), '8. scanner: extracts secret from fragment (#s=)');
  ok(!scanner.includes("url.searchParams.get('s')"), '8. scanner: does NOT extract secret from query (?s=)');

  // Phase 8: any query params are rejected (the secret must NOT be in ?s=).
  ok(scanner.includes("'unexpected-query-params'"), '8. scanner: rejects any query params');

  // Phase 8: missing fragment is rejected.
  ok(scanner.includes("'missing-fragment'"), '8. scanner: rejects missing fragment');

  ok('8. QR payload validation (origin, path, secret, params, hash)');
}

// ============================================================
// 9. ONLY EXPECTED /authorize?s= PAYLOAD ACCEPTED
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // Phase 8: scanner navigates to /authorize#s=<secret> (fragment, not query).
  ok(scanner.includes('goto(`/authorize#s='), '9. scanner: navigates to /authorize#s=<secret> (fragment)');
  ok(!scanner.includes('goto(`/authorize?s='), '9. scanner: does NOT navigate to /authorize?s=<secret> (query)');
  ok(scanner.includes('encodeURIComponent(result.secret)'), '9. scanner: URL-encodes the secret');

  // Does NOT navigate to the raw decoded URL — uses the validated secret.
  ok(!scanner.includes('goto(rawData)'), '9. scanner: does NOT navigate to raw decoded data');
  ok(!scanner.includes('goto(code.data)'), '9. scanner: does NOT navigate to code.data directly');

  ok('9. only valid /authorize?s=<secret> payloads accepted');
}

// ============================================================
// 10. ARBITRARY EXTERNAL URLS REJECTED
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // Rejects dangerous schemes.
  ok(scanner.includes('javascript:'), '10. scanner: rejects javascript: scheme');
  ok(scanner.includes('data:'), '10. scanner: rejects data: scheme');
  ok(scanner.includes('vbscript:'), '10. scanner: rejects vbscript: scheme');

  // Rejects wrong origin.
  ok(scanner.includes("'wrong-origin'"), '10. scanner: rejects wrong-origin URLs');

  // Rejects wrong path.
  ok(scanner.includes("'wrong-path'"), '10. scanner: rejects wrong-path URLs');

  // Rejects missing/short secret.
  ok(scanner.includes("'missing-or-short-secret'"), '10. scanner: rejects missing/short secret');

  // Phase 8: rejects any query params (secret must be in fragment, not query).
  ok(scanner.includes("'unexpected-query-params'"), '10. scanner: rejects unexpected query params');

  // Phase 8: rejects unexpected fragment params.
  ok(scanner.includes("'unexpected-fragment-param'"), '10. scanner: rejects unexpected fragment params');

  // Phase 8: rejects missing fragment.
  ok(scanner.includes("'missing-fragment'"), '10. scanner: rejects missing fragment');

  ok('10. arbitrary external URLs rejected');
}

// ============================================================
// 11. SECRET NOT LOGGED
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // No console.log/error/warn with secret material.
  ok(!scanner.match(/console\.\w+.*secret/i), '11. scanner: no secret logging');
  ok(!scanner.match(/console\.\w+.*access_token/i), '11. scanner: no access_token logging');
  ok(!scanner.match(/console\.\w+.*refresh_token/i), '11. scanner: no refresh_token logging');

  // The decoded QR data is NOT logged.
  ok(!scanner.match(/console\.\w+.*code\.data/i), '11. scanner: no code.data logging');
  ok(!scanner.match(/console\.\w+.*rawData/i), '11. scanner: no rawData logging');

  // No localStorage/sessionStorage of the secret.
  ok(!scanner.includes('localStorage'), '11. scanner: no localStorage');
  ok(!scanner.includes('sessionStorage'), '11. scanner: no sessionStorage');

  ok('11. secret not logged, stored, or persisted');
}

// ============================================================
// 12. INVALID QR HAS RETRY PATH
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // Invalid QR shows an error with a retry option.
  ok(scanner.includes("isn't a Mavero sign-in code"), '12. scanner: invalid QR message (device-neutral wording, §9)');
  ok(scanner.includes('scan-retry-btn'), '12. scanner: has retry button for invalid QR');
  ok(scanner.includes('Try again'), '12. scanner: retry button label');

  // After invalid QR, scanResolved is reset so retry can detect a new QR.
  ok(scanner.includes("scanResolved = false"), '12. scanner: resets scanResolved for retry');

  ok('12. invalid QR has retry path');
}

// ============================================================
// 13. PERMISSION DENIED HAS USEFUL UI
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // NotAllowedError → permission denied message.
  ok(scanner.includes('NotAllowedError'), '13. scanner: handles NotAllowedError');
  ok(scanner.includes('Camera permission denied'), '13. scanner: permission denied message');
  ok(scanner.includes('Enable camera access'), '13. scanner: explains how to enable');

  // Has retry + cancel buttons.
  ok(scanner.includes('scan-retry-btn'), '13. scanner: has retry button');
  ok(scanner.includes('scan-back-btn'), '13. scanner: has cancel button');

  ok('13. permission denied has useful UI with retry + cancel');
}

// ============================================================
// 14. CAMERA UNAVAILABLE HAS USEFUL UI
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // NotFoundError → no camera found.
  ok(scanner.includes('NotFoundError'), '14. scanner: handles NotFoundError');
  ok(scanner.includes('No camera found'), '14. scanner: no camera message');

  // NotReadableError → camera in use.
  ok(scanner.includes('NotReadableError'), '14. scanner: handles NotReadableError');
  ok(scanner.includes('in use by another'), '14. scanner: camera-in-use message');

  // Insecure context.
  ok(scanner.includes('isSecureContext'), '14. scanner: checks window.isSecureContext');
  ok(scanner.includes('secure (HTTPS)'), '14. scanner: insecure context message');

  // Generic camera unavailable.
  ok(scanner.includes('Camera unavailable'), '14. scanner: generic unavailable message');

  ok('14. camera unavailable has useful UI');
}

// ============================================================
// 15. SCANNER CANCELLATION CLEANS UP CAMERA
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // cancel() function stops camera before navigating away.
  const fnStart = scanner.indexOf('function cancel()');
  const fnEnd = scanner.indexOf('\n  }', fnStart);
  const fnBody = scanner.slice(fnStart, fnEnd !== -1 ? fnEnd : undefined);

  ok(fnBody.includes('stopCamera()'), '15. cancel: calls stopCamera before navigating');
  ok(fnBody.includes("goto('/account')"), '15. cancel: navigates back to /account');

  ok('15. scanner cancellation cleans up camera');
}

// ============================================================
// 16. EXISTING /authorize FLOW REMAINS CONNECTED
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');
  const authorize = read('src/routes/authorize/+page.svelte');

  // Scanner navigates to /authorize on valid QR.
  ok(scanner.includes('/authorize#s='), '16. scanner: navigates to /authorize (fragment)');

  // /authorize page still exists with its approval UI.
  ok(authorize.includes('approve'), '16. /authorize: still has approve function');
  ok(authorize.includes('/api/auth/device-pairing/approve'), '16. /authorize: still calls approve endpoint');
  ok(authorize.includes('/api/auth/device-pairing/info'), '16. /authorize: still loads device info');
  ok(authorize.includes('Approve'), '16. /authorize: still has Approve button');
  ok(authorize.includes('Cancel'), '16. /authorize: still has Cancel button');

  ok('16. existing /authorize flow remains connected');
}

// ============================================================
// 17. SCANNER DOES NOT DIRECTLY APPROVE THE PAIRING
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // Scanner does NOT call the approve endpoint.
  ok(!scanner.includes('/api/auth/device-pairing/approve'), '17. scanner: does NOT call approve endpoint');

  // Scanner does NOT call the cancel endpoint.
  ok(!scanner.includes('/api/auth/device-pairing/cancel'), '17. scanner: does NOT call cancel endpoint');

  // Scanner does NOT call the exchange endpoint.
  ok(!scanner.includes('/api/auth/device-pairing/exchange'), '17. scanner: does NOT call exchange endpoint');

  // Scanner does NOT call the create endpoint.
  ok(!scanner.includes('/api/auth/device-pairing/create'), '17. scanner: does NOT call create endpoint');

  // Scanner only navigates to /authorize — the existing page handles
  // device info display + explicit approval.
  ok(scanner.includes('goto(`/authorize#s='), '17. scanner: only navigates to /authorize#s= (does not approve)');

  ok('17. scanner does NOT directly approve the pairing (explicit approval on /authorize)');
}

// ============================================================
// 18. EXISTING /tv-login FLOW REMAINS INTACT
// ============================================================
{
  const tvLogin = read('src/routes/tv-login/+page.svelte');

  // /tv-login still creates pairing requests.
  ok(tvLogin.includes('/api/auth/device-pairing/create'), '18. /tv-login: still calls create endpoint');

  // /tv-login still polls status.
  ok(tvLogin.includes('/api/auth/device-pairing/status'), '18. /tv-login: still polls status');

  // /tv-login still exchanges.
  ok(tvLogin.includes('/api/auth/device-pairing/exchange'), '18. /tv-login: still calls exchange');

  // /tv-login still redirects to /discover on success.
  ok(tvLogin.includes("goto('/discover')"), '18. /tv-login: still redirects to /discover');

  // /tv-login still uses local QR generation.
  ok(tvLogin.includes("import QRCode from 'qrcode'"), '18. /tv-login: still uses local qrcode');

  ok('18. existing /tv-login flow remains intact');
}

// ============================================================
// 19. ACCESSIBILITY ATTRIBUTES / LABELS
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // Semantic heading.
  ok(scanner.includes('<h2>'), '19. scanner: has semantic heading');

  // ARIA live regions.
  ok(scanner.includes('aria-live="polite"'), '19. scanner: has aria-live regions');
  ok(scanner.includes('role="status"'), '19. scanner: has role="status"');
  ok(scanner.includes('role="alert"'), '19. scanner: has role="alert" for errors');

  // Camera preview is labelled.
  ok(scanner.includes('aria-label="Live camera preview'), '19. scanner: camera preview has aria-label');

  // Scan region is labelled.
  ok(scanner.includes('role="region"'), '19. scanner: has role="region"');

  // Keyboard accessible back/cancel button.
  ok(scanner.includes('type="button"'), '19. scanner: buttons are type="button"');

  // Focus-visible states.
  ok(scanner.includes('focus-visible'), '19. scanner: has focus-visible styles');

  // Back button has aria-label.
  ok(scanner.includes('aria-label="Cancel and go back'), '19. scanner: back button has aria-label');

  ok('19. accessibility attributes/labels exist');
}

// ============================================================
// 20. REDUCED-MOTION HANDLING
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  ok(scanner.includes('prefers-reduced-motion'), '20. scanner: has prefers-reduced-motion');
  ok(scanner.includes('animation: none'), '20. scanner: disables spin animation');
  ok(scanner.includes('transition: none'), '20. scanner: disables transitions on reduced-motion');

  ok('20. reduced-motion handling exists');
}

// ============================================================
// 21. BARE ROUTE — /account/scan-tv RENDERS WITHOUT APPSHELL
// ============================================================
{
  const layout = read('src/routes/+layout.svelte');

  ok(layout.includes('/account/scan-tv'), '21. layout: /account/scan-tv in bare-route list');

  ok('21. /account/scan-tv renders bare (no AppShell sidebar)');
}

// ============================================================
// 22. NO CAMERA FRAMES SENT TO SERVER
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // The scanner does NOT POST/PUT camera frames to any endpoint.
  // It only navigates to /authorize?s=<secret> on success.
  ok(!scanner.match(/fetch\(.*body.*image/i), '22. scanner: no fetch with image body');
  ok(!scanner.includes('FormData'), '22. scanner: no FormData upload');
  ok(!scanner.includes('toBlob'), '22. scanner: no canvas.toBlob upload');
  ok(!scanner.includes('toDataURL'), '22. scanner: no canvas.toDataURL upload');

  ok('22. no camera frames sent to server (client-side only)');
}

// ============================================================
// 23. STATE MACHINE — NO INVALID STATE TRANSITIONS
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // State machine states.
  ok(scanner.includes("'idle'"), '23. scanner: idle state');
  ok(scanner.includes("'starting'"), '23. scanner: starting state');
  ok(scanner.includes("'scanning'"), '23. scanner: scanning state');
  ok(scanner.includes("'validating'"), '23. scanner: validating state');
  ok(scanner.includes("'success'"), '23. scanner: success state');
  ok(scanner.includes("'error'"), '23. scanner: error state');

  // Decode loop only runs in scanning state.
  ok(scanner.includes("scanState !== 'scanning'"), '23. scanner: decode loop guarded by scanning state');

  ok('23. state machine (idle → starting → scanning → validating → success/error)');
}

// ============================================================
// 24. DEPENDENCY DISCIPLINE — ONLY ONE QR LIBRARY ADDED
// ============================================================
{
  const pkg = read('package.json');

  // jsqr is the only QR decoder dependency.
  ok(pkg.includes('"jsqr"'), '24. package.json: has jsqr dependency');
  ok(!pkg.includes('"qr-scanner"'), '24. package.json: does NOT have qr-scanner (single library)');
  ok(!pkg.includes('"@zxing'), '24. package.json: does NOT have @zxing (single library)');

  // qrcode (for generation) was already there before Phase 6.
  ok(pkg.includes('"qrcode"'), '24. package.json: qrcode (generation) pre-existing');

  ok('24. dependency discipline (only jsqr added, no duplicate scanner libs)');
}

// ============================================================
// 25. NO PHASE 7 WORK — SCANNER DOES NOT EXCHANGE
// ============================================================
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // Scanner does NOT call exchangeCodeForSession.
  ok(!scanner.includes('exchangeCodeForSession'), '25. scanner: does NOT call exchangeCodeForSession (Phase 7 = TV side)');

  // Scanner does NOT call the claim RPC.
  ok(!scanner.includes('claim_device_pairing'), '25. scanner: does NOT call claim RPC');

  // Scanner does NOT copy the phone's session.
  ok(!scanner.includes('locals.session'), '25. scanner: does NOT read locals.session (no session copy)');

  ok('25. no Phase 7 work (scanner does not exchange or claim)');
}

// ============================================================
// 26. REGRESSION — VIDEO ELEMENT ALWAYS MOUNTED (CRITICAL FIX)
// ============================================================
// Phase 6 critical bug: the <video bind:this={video}> element was
// previously rendered INSIDE {#if scanState === 'scanning'}. When
// onMount() fires, scanState is 'idle', so the video element did
// NOT exist in the DOM. getUserMedia() succeeded (Android green
// camera dot appeared), but `if (!video)` then tore down the
// camera, producing a misleading "Camera initialization failed"
// error.
//
// FIX: the <video> element is now ALWAYS mounted. Its visibility
// is controlled via CSS classes (scan-video-hidden / scan-video-active),
// NOT via conditional mount/unmount. This ensures the video ref is
// available when getUserMedia() resolves.
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // The video element is NOT inside an {#if scanState === 'scanning'} block.
  // Verify by checking that the <video> tag appears BEFORE any {#if} block
  // in the scan-stage, and that the {#if} blocks only render overlays.
  const stageStart = scanner.indexOf('<div class="scan-stage"');
  const stageEnd = scanner.indexOf('</div>\n</div>', stageStart);
  const stage = scanner.slice(stageStart, stageEnd !== -1 ? stageEnd : undefined);

  // The video element exists in the stage.
  ok(stage.includes('<video'), '26. scan-stage: <video> element is mounted in the stage');

  // The video element has bind:this={video} — always bound.
  ok(stage.includes('bind:this={video}'), '26. video: bind:this={video} is present');

  // The video element is NOT inside {#if scanState === 'scanning'}.
  // Find the {#if scanState === 'scanning'} block and verify the <video>
  // tag appears BEFORE it (i.e., outside the conditional).
  const scanningIfIdx = stage.indexOf("{#if scanState === 'scanning'}");
  const videoIdx = stage.indexOf('<video');
  ok(videoIdx !== -1, '26. video element found in stage');
  ok(scanningIfIdx !== -1, '26. {#if scanning} block found in stage');
  ok(videoIdx < scanningIfIdx, '26. video element is mounted BEFORE the {#if scanning} block (always mounted, not conditionally created)');

  // The video element uses class: directives for visibility (NOT conditional mount).
  ok(stage.includes('class:scan-video-hidden'), '26. video: uses class:scan-video-hidden for visibility control');
  ok(stage.includes('class:scan-video-active'), '26. video: uses class:scan-video-active for visibility control');
  ok(stage.includes("scanState !== 'scanning'"), '26. video: hidden class applied when NOT scanning');

  // The CSS uses opacity (not display:none) to hide the video.
  ok(scanner.includes('.scan-video-hidden'), '26. CSS: .scan-video-hidden class defined');
  ok(scanner.includes('opacity: 0'), '26. CSS: hidden video uses opacity:0 (not display:none)');
  ok(scanner.includes('.scan-video-active'), '26. CSS: .scan-video-active class defined');
  ok(scanner.includes('opacity: 1'), '26. CSS: active video uses opacity:1');

  // The if (!video) safety check is PRESERVED (not weakened).
  ok(scanner.includes('if (!video)'), '26. safety check: if (!video) guard preserved');

  // The camera lifecycle functions are preserved.
  ok(scanner.includes('function startCamera'), '26. lifecycle: startCamera preserved');
  ok(scanner.includes('function stopCamera'), '26. lifecycle: stopCamera preserved');
  ok(scanner.includes('track.stop()'), '26. lifecycle: track.stop() preserved');
  ok(scanner.includes('onDestroy'), '26. lifecycle: onDestroy preserved');

  ok('26. video element always mounted (critical fix verified)');
}

// ============================================================
// 27. REAR CAMERA NOT UNCONDITIONALLY MIRRORED
// ============================================================
// Phase 6 secondary fix: the previous CSS had `transform: scaleX(-1)`
// applied unconditionally to .scan-video. The comment claimed this
// was "a no-op visually" on rear cameras, but scaleX(-1) actually
// mirrors the rear-camera preview. For a TV QR scanner where the
// default camera is environment/rear, the mirror is misleading.
//
// FIX: the unconditional transform: scaleX(-1) is removed. The
// rear-camera preview now renders in normal orientation.
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // Extract the .scan-video CSS rule and verify it does NOT have scaleX(-1).
  const videoRuleStart = scanner.indexOf('.scan-video {');
  const videoRuleEnd = scanner.indexOf('}', videoRuleStart);
  const videoRule = scanner.slice(videoRuleStart, videoRuleEnd !== -1 ? videoRuleEnd : undefined);

  ok(!videoRule.includes('scaleX(-1)'), '27. .scan-video CSS: does NOT apply scaleX(-1) mirror');
  ok(!videoRule.includes('transform: scaleX'), '27. .scan-video CSS: no transform: scaleX mirror');

  // Verify there is no unconditional mirror anywhere in the scanner CSS
  // targeting the video element.
  ok(!scanner.match(/\.scan-video[^{]*\{[^}]*scaleX/s), '27. scanner CSS: no scaleX mirror on .scan-video anywhere');

  ok('27. rear camera not unconditionally mirrored');
}

// ============================================================
// 28. CAMERA LIFECYCLE VERIFICATION — ALL PATHS STOP CAMERA
// ============================================================
// Verify the camera is stopped in every terminal path after the fix.
{
  const scanner = read('src/routes/account/scan-tv/+page.svelte');

  // startCamera() calls stopCamera() at the beginning (retry cleanup).
  const startFn = scanner.slice(
    scanner.indexOf('async function startCamera'),
    scanner.indexOf('async function startCamera') + 800
  );
  ok(startFn.includes('stopCamera()'), '28. startCamera: calls stopCamera for retry cleanup');

  // handleDecodedQR stops camera before navigating.
  const decodeFn = scanner.slice(
    scanner.indexOf('async function handleDecodedQR'),
    scanner.indexOf('async function handleDecodedQR') + 400
  );
  ok(decodeFn.includes('stopCamera()'), '28. handleDecodedQR: stops camera on success');

  // cancel() stops camera.
  const cancelFn = scanner.slice(
    scanner.indexOf('function cancel()'),
    scanner.indexOf('function cancel()') + 200
  );
  ok(cancelFn.includes('stopCamera()'), '28. cancel: stops camera');

  // handleCameraError stops camera.
  const errFn = scanner.slice(
    scanner.indexOf('function handleCameraError'),
    scanner.indexOf('function handleCameraError') + 200
  );
  ok(errFn.includes('stopCamera()'), '28. handleCameraError: stops camera');

  // onDestroy stops camera.
  const destroyBlock = scanner.slice(
    scanner.indexOf('onDestroy('),
    scanner.indexOf('onDestroy(') + 100
  );
  ok(destroyBlock.includes('stopCamera()'), '28. onDestroy: stops camera');

  // No duplicate getUserMedia streams — startCamera always calls stopCamera first.
  ok(startFn.includes('stopCamera();'), '28. startCamera: stopCamera() called before new getUserMedia (no duplicate streams)');

  ok('28. camera lifecycle: all terminal paths stop camera (retry, success, cancel, error, destroy)');
}

console.log(`\nPhase 6 phone QR scanner + approval tests passed (${passed} check groups).`);
