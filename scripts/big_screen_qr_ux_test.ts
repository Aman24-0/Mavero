import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isBigScreen, isQrScannerDevice } from '../src/lib/shared/device-class.ts';
import { parseDeviceMetadata } from '../src/lib/server/auth/device-metadata.ts';

// ============================================================
// Newtask §34 test plan — sections F (Account UI) + G (Big-screen QR).
// Static contract + deterministic tests (repo convention).
// ============================================================

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const account = read('src/routes/account/+page.svelte');
const signIn = read('src/routes/auth/sign-in/+page.svelte');
const tvLogin = read('src/routes/tv-login/+page.svelte');
const layout = read('src/routes/+layout.server.ts');
const appHtml = read('src/app.html');
const appDts = read('src/app.d.ts');
const sessionsApi = read('src/routes/api/account/sessions/+server.ts');
const scanTv = read('src/routes/account/scan-tv/+page.svelte');
const authorize = read('src/routes/authorize/+page.svelte');

// ============================================================
// F. ACCOUNT UI (tests 29–36, Newtask §34)
// ============================================================
{
  console.log('F. Account UI');

  // 29. sessions render from server data (fetch to the registry API).
  ok(account.includes("fetch('/api/account/sessions'"), 'F29a: sessions render from the server registry API');
  ok(!/localStorage\.getItem\(['"`][^'"`]*session/.test(account), 'F29b: no localStorage session source');
  ok(!account.includes('Android \u2022 Chrome'), 'F29c: no hardcoded device label in the page');

  // 30. current session correctly identified (server-side isCurrent flag).
  ok(sessionsApi.includes('isCurrent: row.supabase_session_id === currentSessionId'), 'F30a: isCurrent computed server-side from JWT session_id');
  ok(account.includes('session.isCurrent'), 'F30b: UI consumes the per-row isCurrent flag');
  ok(!sessionsApi.includes('currentSessionId }'), 'F30c: raw currentSessionId is NOT returned to the client (RC-6)');
  ok(!sessionsApi.includes('supabase_session_id:'), 'F30d: raw supabase_session_id never projected to the client');

  // 31. newly logged-in browser appears — covered behaviorally by registry v2
  //     (A2/A5); here we pin the refresh plumbing:
  ok(account.includes('sessionRequestSeq'), 'F31a: request sequence guard present');
  ok(/if\s*\(seq\s*!==\s*sessionRequestSeq\)\s*return;/.test(account), 'F31b: stale responses cannot overwrite newer data');

  // 32. logout removes session — the page navigates away on success
  //     (window.location.replace) which reloads the registry server-side.
  ok(account.includes("window.location.replace(target)"), 'F32: sign-out performs a full navigation (clean re-read of auth state)');

  // 33. revoke removes/updates session.
  ok(account.includes("sessions.filter((s) => s.id !== revokeTarget!.id)"), 'F33a: revoked session removed from the list immediately');
  ok(account.includes("loadSessions({ silent: true })"), 'F33b: silent server re-sync after revoke');

  // 34. focus refresh works.
  ok(account.includes("window.addEventListener('focus', refreshSessionsSilently)"), 'F34a: refresh on window focus');
  ok(account.includes("window.removeEventListener('focus', refreshSessionsSilently)"), 'F34b: focus listener cleaned up on destroy');

  // 35. visibility refresh works.
  ok(account.includes("document.addEventListener('visibilitychange', refreshSessionsSilently)"), 'F35a: refresh on visibility change');
  ok(account.includes("document.removeEventListener('visibilitychange', refreshSessionsSilently)"), 'F35b: visibility listener cleaned up on destroy');
  ok(account.includes("document.visibilityState === 'visible'"), 'F35c: refresh only fires while visible');

  // 36. no stale response overwrites newer response (race guard).
  ok(account.includes('const seq = ++sessionRequestSeq;'), 'F36a: every request captures a monotonic sequence');
  const finallyGuard = /finally\s*\{\s*if\s*\(seq\s*===\s*sessionRequestSeq\)\s*sessionsLoading\s*=\s*false;/.test(account);
  ok(finallyGuard, 'F36b: loading state only settles for the latest request');

  // §18 silent refresh keeps cards visible (no UI reset).
  ok(account.includes('options?.silent'), 'F36c: silent mode distinguishes first load from refreshes');

  // §29 timestamps.
  ok(account.includes("'Active now'"), 'F29d: relative "Active now" label');
  ok(account.includes('title={absoluteTime(session.lastSeenAt)}'), 'F29e: absolute timestamp exposed via title tooltip');
}

// ============================================================
// G. BIG-SCREEN QR (tests 37–50, Newtask §34 + §8–§12)
// ============================================================
{
  console.log('G. Big-screen QR');

  // 37/38. desktop + TV see "Login with QR" on the sign-in page.
  ok(signIn.includes('Login with QR'), 'G37a: sign-in page has the "Login with QR" CTA');
  ok(signIn.includes("const showQrLogin = $derived(isBigScreen(data?.deviceType))"), 'G37b: QR CTA gated by server-derived big-screen class');
  ok(signIn.includes('href="/tv-login"'), 'G37c: CTA navigates to the canonical big-screen QR route');

  // 39/40. phone/tablet do NOT see the QR-display CTA.
  ok(isBigScreen('mobile') === false && isBigScreen('tablet') === false, 'G39a: mobile/tablet are not big screens (helper)');
  ok(/isBigScreen\(data\?\.deviceType\)/.test(signIn) && !/isMobile.*Login with QR|Login with QR.*isMobile/.test(signIn), 'G39b: no client-side screen-size gate for the QR CTA (server class only)');

  // 41/42. phone + tablet account pages show "Login on Big Screen".
  ok(account.includes('Login on Big Screen'), 'G41a: Account CTA is named "Login on Big Screen"');
  ok(account.includes('const showBigScreenLogin = $derived(isQrScannerDevice(data.deviceType))'), 'G41b: CTA gated to QR-scanner devices (phone/tablet)');
  ok(!account.includes('>Login on TV<'), 'G41c: TV-specific wording removed from the general account UI');

  // 43/44. desktop/TV account pages hide the button.
  ok(!isBigScreen('mobile') && !isBigScreen('tablet') && !isQrScannerDevice('desktop') && !isQrScannerDevice('tv'), 'G43a: helper classes are mutually exclusive for the two flows');
  ok(account.includes('{#if showBigScreenLogin}'), 'G43b: the CTA is wrapped in the device-class conditional');
  ok(!isQrScannerDevice('unknown'), 'G44a: unknown device class hides the scanner CTA (safest fallback)');

  // 45. QR expires correctly (tv-login states + countdown).
  ok(tvLogin.includes("pairingState === 'expired'"), 'G45a: expired state exists');
  ok(tvLogin.includes('formatCountdown(countdown)'), 'G45b: countdown displayed');
  ok(tvLogin.includes('Code expires in'), 'G45c: expiry communicated to the user');
  ok(tvLogin.includes('Generate new code'), 'G45d: retry regenerates the pairing');

  // 46. consumed QR cannot be reused (RPC-backed single claim).
  const claimRpc = read('supabase/migrations/20260929000000_device_pairing_claim_rpc.sql');
  ok(claimRpc.includes('for update') && claimRpc.includes('consumed'), 'G46a: claim RPC atomically flips approved → consumed');
  const exchange = read('src/routes/api/auth/device-pairing/exchange/+server.ts');
  ok(exchange.includes('claim_device_pairing'), 'G46b: exchange endpoint uses the atomic claim RPC');
  ok(exchange.includes("'cache-control': 'no-store'"), 'G46c: exchange responses are no-store');

  // 47. successful QR login creates an independent Supabase session.
  ok(exchange.includes('exchangeCodeForSession'), 'G47a: TV session established via its OWN exchangeCodeForSession call');
  ok(exchange.includes('const tvSupabase = locals.supabase'), 'G47b: the TV\u2019s SSR client is used (cookies on the TV response)');
  ok(!exchange.includes('S_PHONE') && !exchange.includes('phone.*access_token'), 'G47c: no phone token copying in the exchange path');

  // 48. phone remains authenticated — nothing in the approve flow touches
  //     the phone's session (approve only stores an OTP for the TV).
  const approve = read('src/routes/api/auth/device-pairing/approve/+server.ts');
  ok(!approve.includes('signOut') && !approve.includes('revokeSession'), 'G48: approval does not touch the phone session');

  // 49. big screen remains authenticated after phone local logout.
  const signOut = read('src/routes/auth/sign-out/+server.ts');
  ok(/signOut\(\{\s*scope:\s*['"]local['"]\s*\}\)/.test(signOut), 'G49: phone sign-out is LOCAL scope — big-screen session survives');

  // 50. revoking the big screen does not revoke the phone (revoke-one semantics).
  const revokeApi = read('src/routes/api/account/sessions/revoke/+server.ts');
  ok(revokeApi.includes('revokeSession(admin, user.id, targetRow.supabase_session_id)'), 'G50a: revoke targets ONE session_id (via the single-session service)');
  ok(!revokeApi.includes('revokeAllOtherSessions'), 'G50b: single revoke never cascades');

  // §25 — no stale UI after successful QR login: invalidateAll + goto.
  ok(tvLogin.includes('invalidateAll'), 'G25a: layout data invalidated after QR login (no stale guest UI)');
  ok(/invalidateAll\(\)\.then\(\(\)\s*=>\s*goto\('\/discover'\)\)/.test(tvLogin), 'G25b: navigate after invalidation');
  ok(tvLogin.includes('if (navTimer) clearTimeout(navTimer)'), 'G25c: success-navigation timer cleared on destroy');

  // §25 — clear states + copy.
  ok(tvLogin.includes('Scan with your phone or tablet'), 'G25d: scan instruction names the scanner device');
  ok(tvLogin.includes('approve login on your phone'), 'G25e: waiting state references phone approval');
  ok(tvLogin.includes('Signing you in') || tvLogin.includes("pairingState === 'exchanging'"), 'G25f: exchanging state present');
  ok(tvLogin.includes("You're signed in"), 'G25g: success state present');

  // §26 — phone QR scanner device contract.
  ok(scanTv.includes('getUserMedia'), 'G26a: scanner requests camera permission');
  ok(scanTv.includes('scanResolved = true'), 'G26b: duplicate scans prevented');
  ok(scanTv.includes('stopCamera()'), 'G26c: camera stopped after success/destroy');
  ok(scanTv.includes('destroyed = true'), 'G26d: destroy flag stops the decode loop');

  // §11/§32 — QR security invariants preserved.
  ok(authorize.includes('window.location.hash'), 'G11a: pairing secret stays in the URL fragment (never sent to server)');
  ok(!authorize.includes('exchange_code'), 'G11b: authorize page never references the exchange credential');
  const createApi = read('src/routes/api/auth/device-pairing/create/+server.ts');
  ok(createApi.includes('#s='), 'G11c: QR URL carries the secret in the fragment only');
  ok(!/access_token|refresh_token/.test(tvLogin), 'G32a: no tokens in the tv-login page');
  ok(!/access_token|refresh_token/.test(scanTv), 'G32b: no tokens in the scanner page');
}

// ============================================================
// LAYOUT DEVICE PROJECTION (§7/RC-13 — server-side classification)
// ============================================================
{
  console.log('Layout device projection (§7)');

  ok(layout.includes('parseDeviceMetadata(request.headers.get(\'user-agent\')'), 'L1: layout classifies via the shared server parser');
  ok(layout.includes("request.headers.get('sec-ch-ua')"), 'L2: sec-ch-ua brands forwarded for Brave detection');
  ok(layout.includes('readDeviceHintCookie(cookies.get(DEVICE_HINT_COOKIE))'), 'L3: touch-hint cookie forwarded for iPad detection');
  ok(layout.includes('deviceType'), 'L4: deviceType projected into the page payload');
  ok(appDts.includes("deviceType: 'mobile' | 'tablet' | 'desktop' | 'tv' | 'unknown'"), 'L5: PageData declares deviceType');

  // app.html touch-hint script (descriptive only).
  ok(appHtml.includes('mavero:device-hint=tablet'), 'L6: touch-hint cookie script present');
  ok(appHtml.includes('maxTouchPoints > 1') && appHtml.includes("navigator.platform === 'MacIntel'"), 'L7: hint set only for touch-capable Macs (iPad-as-Mac)');
  ok(appHtml.includes('samesite=lax'), 'L8: hint cookie is lax');

  // Server-side classification is authoritative — the same parser feeds
  // both the registry and the UI.
  const hooks = read('src/hooks.server.ts');
  ok(hooks.includes('parseDeviceMetadata(event.request.headers.get(\'user-agent\')'), 'L9: hooks registry path uses the same parser');
  ok(hooks.includes("event.request.headers.get('sec-ch-ua')"), 'L10: hooks registry path also uses client hints');
}

// ============================================================
// SESSIONS API SAFETY (§16 — DTO shape)
// ============================================================
{
  console.log('Sessions API (§16)');

  ok(sessionsApi.includes('deviceType: row.device_type'), 'S1: deviceType in DTO');
  ok(sessionsApi.includes('deviceName: row.device_name'), 'S2: deviceName in DTO');
  ok(sessionsApi.includes('lastSeenAt: row.last_seen_at'), 'S3: lastSeenAt in DTO');
  ok(sessionsApi.includes('isCurrent'), 'S4: isCurrent flag in DTO');
  const dtoBlock = sessionsApi.slice(sessionsApi.indexOf('const projected'), sessionsApi.indexOf('return json'));
  ok(!dtoBlock.includes('access_token') && !dtoBlock.includes('refresh_token') && !dtoBlock.includes('supabase_session_id:') && !dtoBlock.includes('ip_hash:'), 'S5: no tokens / raw session ids / ip_hash in the DTO');
}

console.log(`\nBig-screen QR UX tests passed (${passed} checks).`);
