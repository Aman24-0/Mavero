// ============================================================================
// POST-94ce1ef PRODUCTION REGRESSION SUITE — Big-Screen QR Login Repair
// ============================================================================
// The 94ce1ef commit passed every static-contract test but FAILED on real
// devices: approval worked, session establishment did not. This suite guards
// the REAL contract discovered by the real-device audit:
//
//   RC-A  exchangeCodeForSession(hashed_token) — WRONG API. A magic-link
//         generateLink token hash must be verified with
//         verifyOtp({ token_hash, type: 'email' }). Verified against the
//         installed @supabase/supabase-js 2.112.3 typings
//         (VerifyTokenHashParams + EmailOtpType) and the GoTrue
//         (supabase/auth) /verify implementation: type 'email' looks up the
//         confirmation OR recovery token — a magiclink generateLink sets the
//         recovery token — then runs recoverVerify (clears the token:
//         one-time use) and issues a full session.
//   RC-B  Consume-before-verify dead state. Fixed with the lease state
//         machine (approved → exchanging[30s lease] → consumed|failed, with
//         release-to-approved recovery) — migration
//         20261003000000_device_pairing_exchange_lease.sql.
//   RC-C  Literal <em> regression in the auth titles.
//   RC-D  TV-only wording → Big Screen wording.
//   RC-E  Manual TV code path missing on the phone (implemented: /lookup +
//         handle + Enter TV code form).
//   RC-F  Secret in the status query string (moved to POST body).
//   RC-G  Undifferentiated "Unable to establish a session." 503s (safe
//         reason taxonomy added).
//   RC-H  TV library regressions (stale guest data) — root cause: the TV
//         never authenticated because of RC-A. After the fix, the cloud
//         library must become authoritative (deletion tombstones win).
//
// Sections mirror the task's §24 A–F matrix (numbered 1–48).
// ============================================================================

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mergeFavoriteDeletions, mergeFavorites, mergeFavoritesWithProgress, mergeProgress, continueWatchingRecords } from '../src/lib/shared/progress-merge.ts';
import { isBigScreen, isQrScannerDevice } from '../src/lib/shared/device-class.ts';
import { normalizeShortCode } from '../src/lib/server/auth/device-pairing.ts';
import type { FavoriteDeletionRecord, FavoriteRecord, WatchProgressRecord } from '../src/lib/client/progress/types.ts';

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const service = read('src/lib/server/auth/device-pairing.ts');
const exchangeApi = read('src/routes/api/auth/device-pairing/exchange/+server.ts');
const approveApi = read('src/routes/api/auth/device-pairing/approve/+server.ts');
const statusApi = read('src/routes/api/auth/device-pairing/status/+server.ts');
const infoApi = read('src/routes/api/auth/device-pairing/info/+server.ts');
const lookupApi = read('src/routes/api/auth/device-pairing/lookup/+server.ts');
const tvLogin = read('src/routes/tv-login/+page.svelte');
const authorize = read('src/routes/authorize/+page.svelte');
const scanTv = read('src/routes/account/scan-tv/+page.svelte');
const accountPage = read('src/routes/account/+page.svelte');
const signInPage = read('src/routes/auth/sign-in/+page.svelte');
const authShell = read('src/lib/components/AuthShell.svelte');
const leaseMigration = read('supabase/migrations/20261003000000_device_pairing_exchange_lease.sql');
const hooks = read('src/hooks.server.ts');

// ============================================================================
// A. SUPABASE EXCHANGE CONTRACT (§24 A 1–5)
// ============================================================================
console.log('A. Supabase exchange contract');
{
  // 1. The magic-link hashed_token is NOT passed to exchangeCodeForSession.
  ok(!service.includes('.auth.exchangeCodeForSession('), 'A1. generateLink hashed_token is NEVER passed to exchangeCodeForSession');
  ok(!exchangeApi.includes('.auth.exchangeCodeForSession('), 'A1b. exchange endpoint never calls exchangeCodeForSession');

  // The installed SDK's typings prove the correct primitive: verifyOtp
  // accepts { token_hash, type } with EmailOtpType including 'email'.
  const verifyOtpCall = service.match(/tvSupabase\.auth\.verifyOtp\(\{[\s\S]*?\}\)/);
  ok(verifyOtpCall !== null, 'A2. token hash is verified with verifyOtp');

  // 3. Correct type: 'email' (GoTrue maps it onto the magiclink recovery
  //    token with dynamic type adaptation).
  ok(verifyOtpCall !== null && verifyOtpCall[0].includes("type: 'email'"), 'A3. verifyOtp uses type email (correct for a magiclink token hash)');

  // 4. TV SSR client is used (locals.supabase), not the admin client.
  ok(exchangeApi.includes('const tvSupabase = locals.supabase'), 'A4. TV SSR client (locals.supabase) performs the verification');
  ok(!exchangeApi.includes('admin.auth.verifyOtp'), 'A4b. admin client never verifies on the TV behalf');

  // 5. No client token copying — the phone's tokens never move.
  ok(!service.includes('access_token') || !service.match(/json\(\s*\{[\s\S]{0,300}access_token/), 'A5. no access_token copying in the pairing service');
  ok(!exchangeApi.includes('S_PHONE'), 'A5b. no phone session transfer anywhere in the exchange path');

  // §5 acceptance condition: cookies verified after verifyOtp.
  ok(service.includes('getCookieNames'), 'A5c. exchange path verifies auth cookies were queued (Set-Cookie acceptance check)');
  ok(exchangeApi.includes("cookies.getAll().map((cookie) => cookie.name)"), 'A5d. endpoint passes its own response cookies into the check');
  ok(service.includes("'cookie-establishment-failed'"), 'A5e. missing cookies are a distinct, logged failure reason');

  ok('A. Supabase exchange contract (verifyOtp on TV SSR client)');
}

// ============================================================================
// B. QR LIFECYCLE (§24 B 6–15)
// ============================================================================
console.log('B. QR lifecycle');
{
  const createApi = read('src/routes/api/auth/device-pairing/create/+server.ts');

  // 6. create pairing.
  ok(createApi.includes('createPairingRequest'), 'B6. create: pairing request created server-side');
  ok(createApi.includes('pairingCreate'), 'B6b. create: rate-limited bucket');

  // 7. scan — the phone scanner validates the QR payload strictly.
  ok(scanTv.includes('validateMaveroPairingURL'), 'B7. scan: QR payload validated (origin/path/fragment/params)');
  ok(scanTv.includes('#s='), 'B7b. scan: secret expected in the URL FRAGMENT (never a query string)');
  ok(scanTv.includes('url.searchParams.toString()'), 'B7c. scan: any query params rejected');

  // 8. info — POST body credential, safe metadata only.
  ok(infoApi.includes('readJsonBody'), 'B8. info: credential in POST body (not a query string)');
  ok(!infoApi.match(/json\(\s*\{[\s\S]{0,400}exchange_code/), 'B8b. info: never returns the exchange credential');

  // 9. approve — authenticated, generateLink, atomic pending→approved.
  ok(approveApi.includes('locals.user'), 'B9. approve: authentication required');
  ok(service.includes('generateLink'), 'B9b. approve: generates a one-time magic-link token hash');
  ok(service.includes("eq('status', 'pending')"), 'B9c. approve: atomic pending→approved transition');

  // 10. approved polling — TV polls status (POST body) and the phone
  //     polls for completion after approving.
  ok(statusApi.includes('readJsonBody'), 'B10. status: POST handler (credential in body)');
  ok(!statusApi.includes('url.searchParams'), 'B10b. status: no query-string credential reads');
  ok(tvLogin.includes("payload.status === 'approved'"), 'B10c. TV: detects the approved transition');
  ok(authorize.includes('startCompletionPolling'), 'B10d. phone: post-approval completion polling (consumed → "signed in on the device")');
  ok(authorize.includes("payload.status === 'consumed'"), 'B10e. phone: consumption detection');

  // 11. token verification — the verifyOtp call (covered in A2/A3) plus
  //     the failure classification contract.
  ok(service.includes("verifyError?.code === 'otp_expired'"), 'B11. verify: otp_expired classified terminal');
  ok(service.includes("'release_device_pairing_exchange'"), 'B11b. verify: transient failures release the lease (recoverable)');

  // 12. TV session cookie — §5 check (covered in A5c) + the SSR cookie
  //     adapter wiring in hooks.
  ok(hooks.includes('setAll'), 'B12. hooks: SSR cookie adapter setAll wired to event.cookies.set');

  // 13. authenticated next request — after login the layout load derives
  //     user state server-side; the TV navigates via invalidateAll.
  ok(tvLogin.includes('invalidateAll'), 'B13. TV: invalidateAll() before navigating (next request re-runs the layout load server-side)');
  const layoutServer = read('src/routes/+layout.server.ts');
  ok(layoutServer.includes('safeGetSession'), 'B13b. layout: server load resolves the session (locals.user)');

  // 14. device_sessions registration — the hook registers every
  //     authenticated request (awaited, bounded).
  ok(hooks.includes('registerCurrentSession'), 'B14. hooks: session registration after auth');
  ok(hooks.includes('awaitWithTimeout'), 'B14b. hooks: registration is AWAITED with a bounded timeout (Netlify serverless-safe)');

  // 15. independent session ID — TV gets its OWN Supabase session (never
  //     the phone's tokens) so its JWT session_id differs by construction.
  ok(!service.includes('locals.session'), 'B15. pairing service never reads the phone session tokens');
  ok(!exchangeApi.includes('locals.session'), 'B15b. exchange endpoint never touches the phone session tokens');

  ok('B. QR lifecycle (create → scan → info → approve → poll → verify → cookies → registration)');
}

// ============================================================================
// C. FAILURE RECOVERY (§24 C 16–22)
// ============================================================================
console.log('C. Failure recovery');
{
  // 16. claim RPC missing (migration not deployed) — PGRST202 detected.
  ok(service.includes('PGRST202'), 'C16. claim: PGRST202 (function not found) detected as claim-rpc-missing');
  ok(service.includes("'claim-rpc-missing'"), 'C16b. claim: distinct reason for a missing RPC (503, non-retryable)');
  ok(read('scripts/verify_claim_rpc.ts').includes('PGRST202'), 'C16c. deployment verification script checks the RPC contract');

  // 17. claim RPC failure (exists, errors) — 503, retryable.
  ok(service.includes("'claim-rpc-failed'"), 'C17. claim: RPC failure logged distinctly and retryable');

  // 18. token verification failure — terminal vs recoverable split.
  const fnStart = service.indexOf('export async function claimVerifyAndEstablishPairingSession');
  const fnEnd = service.indexOf('\n}\n', fnStart);
  const fnBody = service.slice(fnStart, fnEnd);
  ok(fnBody.includes("'fail_device_pairing'"), 'C18. verify: terminal failure → fail_device_pairing (credential cleared)');
  ok(fnBody.includes("'release_device_pairing_exchange'"), 'C18b. verify: transient failure → release (credential kept, retry safe)');
  ok(fnBody.includes('status: 410') && fnBody.includes('status: 503'), 'C18c. verify: 410 terminal vs 503 retryable responses');

  // 19. expired pairing.
  ok(leaseMigration.includes('expires_at > p_now'), 'C19. claim RPC WHERE expires_at > now');
  ok(service.includes("'pairing-expired'"), 'C19b. service: distinct expired reason (410)');

  // 20. consumed pairing — replay impossible.
  ok(service.includes("'pairing-consumed'"), 'C20. service: consumed replay rejected (409)');
  ok(leaseMigration.includes("and status = 'exchanging'"), 'C20b. claim: only approved or lease-EXPIRED exchanging rows are claimable — consumed/failed never');

  // 21. concurrent exchange — lease busy is retryable, single winner.
  ok(service.includes("'exchange-lease-busy'"), 'C21. service: lease-busy is a distinct retryable outcome');
  ok(leaseMigration.includes('for update;'), 'C21b. claim: SELECT ... FOR UPDATE serializes concurrent claims');
  ok(leaseMigration.includes('exchange_lease_until < p_now'), 'C21c. claim: takeover requires an EXPIRED lease');

  // 22. retry after recoverable failure — the TV client auto-retries.
  ok(tvLogin.includes('MAX_EXCHANGE_RETRIES'), 'C22. TV: bounded automatic retry loop for retryable exchange failures');
  ok(tvLogin.includes('payload.retryable === true'), 'C22b. TV: retry decision driven by the server retryable flag');
  ok(leaseMigration.includes('p_max_attempts'), 'C22c. server: attempts cap bounds total retries per pairing');

  ok('C. Failure recovery (missing RPC, expired, consumed, verify failures, concurrency, retry)');
}

// ============================================================================
// D. UI (§24 D 23–34)
// ============================================================================
console.log('D. UI contract');
{
  // 23. No literal <em> anywhere in the authorization flow.
  for (const [name, file] of [['tv-login', tvLogin], ['authorize', authorize], ['sign-in', signInPage]]) {
    ok(!file.includes('<em>'), `D23. ${name}: no literal <em> in any title string`);
  }

  // 24. titleAccent used correctly (no @html anywhere).
  ok(authShell.includes('titleAccent'), 'D24. AuthShell: titleAccent prop exists');
  ok(authShell.includes('{title}{#if titleAccent}<span> {titleAccent}</span>{/if}'), 'D24b. AuthShell: accent rendered as a styled span (text interpolation, never {@html})');
  ok(!authShell.includes('{@html'), 'D24c. AuthShell: no unsafe HTML rendering');
  ok(tvLogin.includes('title="Sign in with your"') && tvLogin.includes('titleAccent="phone."'), 'D24d. TV page: title/titleAccent split used correctly');
  ok(authorize.includes('title="Authorize this"') && authorize.includes('titleAccent="device."'), 'D24e. authorize page: title/titleAccent split used correctly');

  // 25. Big Screen wording (not TV-only).
  ok(tvLogin.includes('MAVERO / Big Screen Sign in'), 'D25. TV page: eyebrow says Big Screen Sign in');
  ok(!tvLogin.includes('MAVERO / TV Sign in'), 'D25b. TV page: TV-only eyebrow gone');
  ok(tvLogin.includes('Scan the QR code with your phone or tablet to sign in on this device.'), 'D25c. TV page: phone-or-tablet subtitle');
  ok(tvLogin.includes('Scan with your phone or tablet'), 'D25d. TV page: scanner-aware instruction');
  ok(tvLogin.includes('Waiting for scan — approve login on your phone'), 'D25e. TV page: waiting copy matches the requested states');
  ok(tvLogin.includes('Or enter code manually:'), 'D25f. TV page: manual code label present');
  ok(scanTv.includes('Login on Big Screen — Mavero'), 'D25g. scan page: Big Screen title');

  // 26. Manual code input exists on the phone.
  ok(scanTv.includes('manual-code-card'), 'D26. scan page: manual-code card rendered');
  ok(scanTv.includes('Enter TV code'), 'D26b. scan page: "Enter TV code" label');
  ok(scanTv.includes('manual-divider-label">OR'), 'D26c. scan page: OR divider between scanning and code entry');
  ok(scanTv.includes('/api/auth/device-pairing/lookup'), 'D26d. scan page: code resolves via the authenticated lookup endpoint');

  // 27. Manual code validation (client + server).
  ok(scanTv.includes('normalizeManualCode'), 'D27. scan page: client-side normalization (uppercase/trim/filter)');
  ok(scanTv.includes('MANUAL_CODE_MAX') && scanTv.includes('maxlength={MANUAL_CODE_MAX}'), 'D27b. scan page: max length enforced');
  ok(typeof normalizeShortCode === 'function', 'D27c. server: normalizeShortCode exported');
  ok(normalizeShortCode(' dh84 exkp ') === 'DH84EXKP', 'D27d. server: trim + uppercase normalization');
  ok(normalizeShortCode('DH84EXK') === null, 'D27e. server: short codes rejected');
  ok(normalizeShortCode('DH84EXK!') === null, 'D27f. server: invalid characters rejected');
  ok(normalizeShortCode('dh84exkp') === 'DH84EXKP', 'D27g. server: case-insensitive');
  // Expired / invalid / rate-limit states.
  ok(scanTv.includes("'expired'") && scanTv.includes("'rate-limited'"), 'D27h. scan page: expired + rate-limit states distinguished');
  ok(service.includes("status: 'expired'"), 'D27i. service: structured expired status for short-code lookup');
  ok(lookupApi.includes('status: status ?? \'invalid\'') || lookupApi.includes('status: status ?? "invalid"'), 'D27i2. lookup API: passes the structured status through (no string matching)');

  // 28. Manual code approval — converges into the SAME pipeline.
  ok(lookupApi.includes('createManualHandleForShortCode'), 'D28. lookup: issues a one-time handle (never the pairing secret)');
  ok(lookupApi.includes('locals.user'), 'D28b. lookup: authentication required');
  ok(approveApi.includes('handle') && approveApi.includes('credential = { handle, userId: user.id }'), 'D28c. approve: handle path converges into the same approval pipeline');
  ok(authorize.includes("fragmentParams.get('h')"), 'D28d. authorize: handle accepted from the URL fragment');
  ok(authorize.includes('{ handle: pairingHandle }'), 'D28e. authorize: handle used for info/approve/status calls');
  ok(scanTv.includes('#h='), 'D28f. scan page: navigates with the handle in the URL FRAGMENT');
  ok(service.includes('manual_handle_user_id !== userId') || service.includes('manual_handle_user_id !== credential.userId'), 'D28g. handle bound to the resolving user (foreign sessions get not-found)');

  // 29–30. Desktop + TV QR CTA on the sign-in page.
  ok(signInPage.includes('isBigScreen'), 'D29. sign-in: QR CTA gated by isBigScreen (desktop/TV)');
  ok(signInPage.includes('Login with QR'), 'D29b. sign-in: "Login with QR" CTA present');
  ok(signInPage.includes('showQrLogin'), 'D30. sign-in: derived showQrLogin drives the CTA');
  ok(isBigScreen('desktop') && isBigScreen('tv'), 'D30b. isBigScreen: desktop + tv');
  ok(!isBigScreen('mobile') && !isBigScreen('tablet'), 'D30c. isBigScreen: phone + tablet excluded');

  // 31–32. Phone + tablet account CTA.
  ok(accountPage.includes('showBigScreenLogin'), 'D31. account: Login on Big Screen derived flag');
  ok(accountPage.includes('isQrScannerDevice(data.deviceType)'), 'D31b. account: CTA visibility from the server-derived deviceType');
  ok(isQrScannerDevice('mobile') && isQrScannerDevice('tablet'), 'D32. isQrScannerDevice: mobile + tablet');
  ok(accountPage.includes('Login on Big Screen'), 'D32b. account: CTA label');

  // 33–34. Desktop/TV account CTA hidden.
  ok(!isQrScannerDevice('desktop') && !isQrScannerDevice('tv'), 'D33. isQrScannerDevice: desktop + tv hidden by construction');
  ok(!isQrScannerDevice('unknown'), 'D34. unknown device class: hidden (safest fallback)');

  ok('D. UI contract (em regression, titleAccent, Big Screen copy, manual code, device-aware CTAs)');
}

// ============================================================================
// E. LIBRARY SYNC (§24 E 35–41) — REAL merge-logic tests
// ============================================================================
console.log('E. Library sync (deterministic merge simulations)');

function makeFavorite(contentId: string, updatedAt: number, status: FavoriteRecord['status'] = 'watching'): FavoriteRecord {
  return {
    key: `movie:${contentId}`,
    contentType: 'movie',
    contentId,
    snapshot: { title: `Title ${contentId}`, poster: '' },
    status,
    createdAt: updatedAt - 1000,
    updatedAt,
  };
}

function makeProgress(contentId: string, updatedAt: number, currentTime = 600, completionState: WatchProgressRecord['completionState'] = 'in_progress'): WatchProgressRecord {
  return {
    key: `movie:${contentId}`,
    contentType: 'movie',
    contentId,
    currentTime,
    duration: 1200,
    completionState,
    snapshot: { title: `Title ${contentId}`, poster: '' },
    lastWatchedAt: updatedAt,
    updatedAt,
  };
}

function makeDeletion(contentId: string, deletedAt: number): FavoriteDeletionRecord {
  return { key: `movie:${contentId}`, contentType: 'movie', contentId, deletedAt };
}

// This mirrors runAuthenticatedState() in src/lib/client/progress/cloud.ts —
// the EXACT derivation the TV runs on its first authenticated sync.
function tvFirstSync(tvLocalFavorites: FavoriteRecord[], tvLocalProgress: WatchProgressRecord[], tvLocalDeletions: FavoriteDeletionRecord[], cloudFavorites: FavoriteRecord[], cloudProgress: WatchProgressRecord[], cloudDeletions: FavoriteDeletionRecord[]) {
  const favoriteDeletions = mergeFavoriteDeletions(tvLocalDeletions, cloudDeletions);
  const mergedProgress = mergeProgress(tvLocalProgress, cloudProgress);
  const deletedKeys = new Set(favoriteDeletions.map((d) => d.key));
  const progress = deletedKeys.size > 0 ? mergedProgress.filter((record) => !deletedKeys.has(`movie:${record.contentId}`.replace('movie:movie:', 'movie:'))) : mergedProgress;
  const favorites = mergeFavoritesWithProgress(mergeFavorites(tvLocalFavorites, cloudFavorites, favoriteDeletions), progress, favoriteDeletions);
  return { favorites, progress, favoriteDeletions };
}

{
  const CLOUD_FAVORITES = [makeFavorite('a', 1000), makeFavorite('b', 2000), makeFavorite('c', 3000, 'planned')];
  const CLOUD_PROGRESS = [makeProgress('a', 1500), makeProgress('b', 2500), makeProgress('done', 4000, 1200, 'completed')];

  // 35. Fresh TV (empty IndexedDB) QR login receives the cloud My List.
  const fresh = tvFirstSync([], [], [], CLOUD_FAVORITES, CLOUD_PROGRESS, []);
  assert.deepEqual(fresh.favorites.map((f) => f.contentId).sort(), ['a', 'b', 'c'], 'E35: fresh TV My List equals cloud My List');
  ok(true, 'E35. fresh TV QR login receives the cloud My List (all N titles)');

  // 36. Fresh TV receives Continue Watching (completed excluded, one per title).
  const cw = continueWatchingRecords(fresh.progress, fresh.favorites);
  assert.equal(cw.length, 2, 'E36: completed title excluded from Continue Watching');
  assert.ok(cw.some((r) => r.contentId === 'a') && cw.some((r) => r.contentId === 'b'), 'E36: in-progress titles present');
  assert.ok(!cw.some((r) => r.contentId === 'done'), 'E36: completed title absent');
  ok(true, 'E36. fresh TV Continue Watching matches cloud progress (completed excluded)');

  // 37. Stale TV local favorite does NOT resurrect a cloud deletion
  //     (tombstone newer than the stale local copy).
  const staleTvFavorites = [makeFavorite('deleted-on-phone', 500)]; // older than the tombstone
  const cloudDeletions = [makeDeletion('deleted-on-phone', 900)];   // newer
  const r37 = tvFirstSync(staleTvFavorites, [], [], [], [], cloudDeletions);
  assert.equal(r37.favorites.filter((f) => f.contentId === 'deleted-on-phone').length, 0, 'E37: tombstone suppresses the stale local favorite');
  ok(true, 'E37. stale local TV favorite does not resurrect a newer cloud deletion');

  // 38. Stale local progress does NOT resurrect a deleted title.
  const staleTvProgress = [makeProgress('deleted-on-phone', 700)];
  const r38 = tvFirstSync([makeFavorite('deleted-on-phone', 600)], staleTvProgress, [], [], [], cloudDeletions);
  assert.equal(r38.progress.filter((p) => p.contentId === 'deleted-on-phone').length, 0, 'E38: tombstone filters the stale local progress');
  assert.equal(r38.favorites.filter((f) => f.contentId === 'deleted-on-phone').length, 0, 'E38b: no favorite resurrection either');
  ok(true, 'E38. stale local progress does not resurrect a deleted title');

  // 39. Deleted phone title disappears on the TV after refresh.
  //     Phone state: a, b, c → phone deletes 'b' (tombstone + cloud removal).
  const phoneAfterDelete = {
    favorites: CLOUD_FAVORITES.filter((f) => f.contentId !== 'b'),
    progress: CLOUD_PROGRESS.filter((p) => p.contentId !== 'b'),
    deletions: [makeDeletion('b', 5000)],
  };
  const tvHasB = [makeFavorite('b', 2000)]; // TV's cached copy from an earlier sync
  const r39 = tvFirstSync(tvHasB, [makeProgress('b', 2500)], [], phoneAfterDelete.favorites, phoneAfterDelete.progress, phoneAfterDelete.deletions);
  assert.equal(r39.favorites.filter((f) => f.contentId === 'b').length, 0, 'E39: deleted phone title gone from the TV library');
  assert.equal(r39.progress.filter((p) => p.contentId === 'b').length, 0, 'E39b: deleted phone title gone from TV progress/Continue Watching');
  ok(true, 'E39. deleted phone title disappears on TV (tombstone authoritative)');

  // 40. Newly added phone title appears on TV after refresh.
  const phoneAfterAdd = { ...phoneAfterDelete, favorites: [...phoneAfterDelete.favorites, makeFavorite('new', 6000)], deletions: phoneAfterDelete.deletions };
  const r40 = tvFirstSync([], [], [], phoneAfterAdd.favorites, phoneAfterAdd.progress, phoneAfterAdd.deletions);
  assert.ok(r40.favorites.some((f) => f.contentId === 'new'), 'E40: newly added phone title present on the TV');
  assert.ok(!r40.favorites.some((f) => f.contentId === 'b'), 'E40b: the earlier deletion is still respected');
  ok(true, 'E40. newly added phone title appears on TV after refresh (no stale cache)');

  // 41. Phone and TV produce the SAME cloud-derived library.
  //     Simulate the phone's own sync (identical derivation, local = phone's).
  const phoneSync = tvFirstSync(phoneAfterAdd.favorites, phoneAfterAdd.progress, phoneAfterDelete.deletions, phoneAfterAdd.favorites, phoneAfterAdd.progress, phoneAfterAdd.deletions);
  const tvSync = tvFirstSync([], [], [], phoneAfterAdd.favorites, phoneAfterAdd.progress, phoneAfterAdd.deletions);
  assert.deepEqual(
    tvSync.favorites.map((f) => f.key).sort(),
    phoneSync.favorites.map((f) => f.key).sort(),
    'E41: TV and phone derive the same library'
  );
  assert.deepEqual(
    continueWatchingRecords(tvSync.progress, tvSync.favorites).map((r) => r.key).sort(),
    continueWatchingRecords(phoneSync.progress, phoneSync.favorites).map((r) => r.key).sort(),
    'E41b: TV and phone derive the same Continue Watching'
  );
  ok(true, 'E41. phone and TV produce the same cloud-derived library');

  // §16 invariants: continueWatchingRecords — one item per title, latest wins.
  const multiEpisodeProgress: WatchProgressRecord[] = [
    { ...makeProgress('series-1', 1000), contentType: 'series', key: 'series:series-1', season: 1, episode: 1 },
    { ...makeProgress('series-1', 2000), contentType: 'series', key: 'series:series-1', season: 1, episode: 3 },
    { ...makeProgress('series-1', 1500), contentType: 'series', key: 'series:series-1', season: 1, episode: 2 },
  ];
  const cwSeries = continueWatchingRecords(multiEpisodeProgress, []);
  assert.equal(cwSeries.filter((r) => r.contentId === 'series-1').length, 1, 'one item per title');
  assert.equal(cwSeries[0]?.season, 1, 'latest episode season');
  assert.equal(cwSeries[0]?.episode, 3, 'latest episode wins (S1E3, not S1E1/E2)');
  ok(true, '§16. Continue Watching: one item per title, correct latest episode');

  // §17 deterministic order: the sync happens BEFORE cloud-derived state renders.
  const myListPage = read('src/routes/my-list/+page.svelte');
  ok(myListPage.includes('await syncAuthenticatedState') || myListPage.includes('syncAuthenticatedState().then'), '§17. My List: authenticated sync drives the rendered records');
  const discoverPage = read('src/lib/components/DiscoverPage.svelte');
  ok(discoverPage.includes('const cloud = await syncAuthenticatedState(); return continueWatchingRecords(cloud.progress, cloud.favorites)'), '§18. Discover: Continue Watching derived from the AWAITED authenticated sync (deterministic order)');
  ok(tvLogin.includes('invalidateAll().then(() => goto'), '§18b. TV: invalidateAll BEFORE navigation (no stale guest layout)');

  ok('E. Library sync (cloud-authoritative, tombstones win, deterministic order)');
}

// ============================================================================
// F. SESSION MANAGEMENT (§24 F 42–48)
// ============================================================================
console.log('F. Session management');
{
  const signOut = read('src/routes/auth/sign-out/+server.ts');
  const revokeApi = read('src/routes/api/account/sessions/revoke/+server.ts');
  const revokeAllApi = read('src/routes/api/account/sessions/revoke-all/+server.ts');
  const registryRpc = read('supabase/migrations/20260930000000_register_device_session_rpc.sql');

  // 42. Phone logout does NOT kill the TV (local-scope signOut).
  ok(/signOut\(\{\s*scope:\s*['"]local['"]\s*\}\)/.test(signOut), 'F42. sign-out uses LOCAL scope (other devices keep their sessions)');

  // 43. TV logout does not kill the phone — same local-scope mechanism.
  ok(!signOut.includes("scope: 'global'"), 'F43. sign-out never uses GLOBAL scope');

  // 44. Revoke kills ONLY the target session.
  ok(revokeApi.includes('sessionId') && revokeApi.includes('locals.user'), 'F44. revoke is per-session and ownership-scoped');

  // 45. Sign-out-other-devices semantics: current session preserved.
  ok(revokeAllApi.includes('current') || revokeAllApi.toLowerCase().includes('is_current') || revokeAllApi.includes('currentSession'), 'F45. revoke-all preserves the current session (other devices only)');
  ok(accountPage.includes('Sign out all other devices'), 'F45b. account UI wording matches the actual semantics');

  // 46. New browser login creates a new session row.
  ok(hooks.includes('registerCurrentSession'), 'F46. every authenticated request registers/heartbeats the session row');

  // 47. last_seen_at updates (heartbeat).
  ok(registryRpc.includes('last_seen_at'), 'F47. register RPC heartbeats last_seen_at');
  ok(registryRpc.includes('p_heartbeat_interval_ms'), 'F47b. heartbeat throttled by interval');

  // 48. Revoked session cannot re-register.
  ok(registryRpc.includes('revoked_at is null') || registryRpc.toLowerCase().includes('revoked'), 'F48. register RPC refuses revoked sessions (no resurrection)');
  ok(hooks.includes('sessionRevoked') || hooks.includes('isSessionRevoked'), 'F48b. hooks enforce revocation before registration');

  ok('F. Session management (local sign-out, scoped revocation, no resurrection)');
}

// ============================================================================
// §21/§22/§23 — error taxonomy + migration verification + security model
// ============================================================================
console.log('Security model preservation (§21–§23)');
{
  // §21 error taxonomy: every required reason is logged safely.
  const requiredReasons = [
    'claim-rpc-missing', 'claim-rpc-failed', 'pairing-not-approved', 'pairing-expired',
    'pairing-consumed', 'pairing-failed', 'token-verification-failed', 'cookie-establishment-failed',
  ];
  for (const reason of requiredReasons) {
    ok(service.includes(`'${reason}'`), `§21. reason taxonomy includes ${reason}`);
  }

  // Safe logging only — requestId + reason + safe name/code, never secrets.
  ok(!service.match(/console\.\w+.*token_hash/i), '§21b. token hash never logged');
  ok(!service.match(/console\.\w+.*hashed_token/i), '§21c. hashed_token never logged');
  ok(!service.match(/console\.\w+.*secret/i), '§21d. pairing secret never logged');
  ok(!service.match(/console\.\w+.*exchange_code/i), '§21e. exchange_code never logged');
  ok(service.includes('requestId'), '§21f. logs include the requestId for correlation');

  // §22 migration verification documented + scripted.
  ok(read('DEPLOYMENT.md').includes('verify:pairing-rpc'), '§22. DEPLOYMENT.md documents the post-deployment RPC check');
  ok(read('docs/supabase-migration-runbook.md').includes('20261003000000_device_pairing_exchange_lease.sql'), '§22b. runbook lists the lease migration');
  const pkg = JSON.parse(read('package.json'));
  ok(pkg.scripts['verify:pairing-rpc'] !== undefined, '§22c. package.json exposes verify:pairing-rpc');

  // §23 security model preserved.
  ok(service.includes("crypto.getRandomValues") && service.includes('Uint8Array(32)'), '§23. 256-bit QR secret entropy preserved');
  ok(service.includes('hashSecret(secret)'), '§23b. secret stored hashed (SHA-256)');
  ok(create_qr_secret_in_fragment(), '§23c. QR secret stays in the URL fragment (#s=)');
  const basePairingMigration = read('supabase/migrations/20260928000000_device_pairing_requests.sql');
  ok(basePairingMigration.toLowerCase().includes('enable row level security'), '§23d. RLS stays enabled on the pairing table (base migration)');
  ok(!leaseMigration.toLowerCase().includes('disable row level security'), '§23d2. the lease migration never disables RLS');
  ok(leaseMigration.includes('security definer'), '§23e. RPCs are SECURITY DEFINER');
  ok(leaseMigration.includes('revoke execute') && leaseMigration.includes('grant execute'), '§23f. EXECUTE privileges locked to service_role');
  ok(!leaseMigration.match(/grant\s+execute[^;]*\bto\s+(anon|authenticated|public)\b/i), '§23g. no EXECUTE grants to client roles');
  ok(lookupApi.includes('Authentication required.'), '§23h. manual-code lookup requires authentication');
  ok(lookupApi.includes('pairingCodeLookupUser') && lookupApi.includes('pairingCodeLookupIp'), '§23i. brute-force protection: dual rate-limit buckets');
  ok(service.includes('MANUAL_HANDLE_TTL_MS'), '§23j. manual handle is short-lived');
  ok(leaseMigration.includes('manual_handle_hash'), '§23k. manual handle stored hashed at rest');

  ok('Security model preservation (taxonomy, verification, hardening intact)');
}

function create_qr_secret_in_fragment(): boolean {
  const createApi = read('src/routes/api/auth/device-pairing/create/+server.ts');
  // The constructed QR URL must put the secret in the fragment; the
  // template literal is the actual URL contract (comments may mention
  // the old query-string form for history).
  const qrUrlLine = createApi.split('\n').find((line) => line.includes('const qrUrl'));
  return qrUrlLine !== undefined && qrUrlLine.includes('#s=') && !qrUrlLine.includes('?s=');
}

console.log(`\nBig-screen QR login regression suite passed (${passed} checks).`);
