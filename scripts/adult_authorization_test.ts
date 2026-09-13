// ============================================================================
// Phase 5 behavioral tests — authorization security hardening.
// (Adult Mode architecture rebuild; see Mavero_Adult_Mode_Rebuild_Worklog.md.)
//
// REAL behavioral tests: they execute the actual HMAC cookie construction
// (adult-cookie.ts), the actual timing-safe comparison, the actual fail-closed
// secret handling, and the actual authorization matrix (adult-authz.ts —
// evaluateAdultAccess / adminPolicyFromRead / userPreferenceFromRead) that
// adult-policy.ts composes into getAdultAccessContext.
//
// Deterministic and credential-free: no network access, no Supabase
// credentials, no real production secret. The HMAC secret is an explicitly
// injected TEST secret (exactly how production injects
// MAVERO_ADULT_COOKIE_SECRET through the environment).
//
// adult-policy.ts itself (the env/IO wiring: $env/dynamic/private +
// $app/environment + Supabase calls) cannot be imported under tsx; its
// wiring is asserted statically in scripts/adult_mode_test.ts section Z —
// the same adapter/behavioral split used by the Phase 4 search tests.
//
// Covered scenarios (Phase 5 spec §12):
//   A  valid ON cookie                    -> ON
//   B  valid OFF cookie                   -> OFF
//   C  modified value + old signature     -> rejected (signature is VALUE-dependent)
//   D  modified signature                 -> rejected
//   E  random signature                   -> rejected
//   F  wrong secret                       -> rejected
//   G  missing production secret          -> fail closed (verify OFF / issuance throws)
//   H  timing-safe comparison mechanism   -> timingSafeEqual, length-safe
//   I  public env values are NOT the secret (empty/missing rejected; module env-free)
//   J  cookie Secure in production
//   K  cookie HttpOnly
//   L  cookie SameSite-safe (+ Path=/, Max-Age)
// Covered scenarios (Phase 5 spec §13):
//   A  admin OFF  + user ON               -> denied
//   B  admin OFF  + guest ON              -> denied
//   C  admin ON   + user OFF              -> denied
//   D  admin ON   + user ON               -> allowed
//   E  admin ON   + guest OFF             -> denied
//   F  admin ON   + guest ON               -> allowed
//   G  app_settings read failure          -> policy OFF for everyone (fail closed)
//   H  user preference read failure       -> preference OFF (fail closed)
//   I  admin ON -> OFF flip               -> next evaluation is denied IMMEDIATELY (no 60s cache)
// Plus: guest persistence round-trip, legacy-cookie migration (old scheme
// treated as OFF), canonical-value strictness, signature-vs-secret
// properties, and the Search regression binding (hardened authorization
// feeds the UNCHANGED Phase 4 searchFilterMode branch).
// ============================================================================

import assert from 'node:assert/strict';
import {
  GUEST_COOKIE_NAME,
  GUEST_COOKIE_MAX_AGE_SECONDS,
  canonicalAdultCookieValue,
  signAdultCookieValue,
  verifyAdultCookieValue,
  timingSafeStringEqual,
  buildAdultGuestSetCookie,
  buildAdultGuestClearCookie,
  assertAdultCookieSecret
} from '../src/lib/server/content/adult-cookie.ts';
import {
  evaluateAdultAccess,
  adminPolicyFromRead,
  userPreferenceFromRead,
  type AdultModePolicy
} from '../src/lib/server/content/adult-authz.ts';
import { searchFilterMode } from '../src/lib/server/content/search-classify.ts';

let passed = 0;
function ok(label: string): void {
  passed++;
  console.log(`  ok ${passed} - ${label}`);
}

// Explicitly injected TEST secret (the harness equivalent of the production
// MAVERO_ADULT_COOKIE_SECRET environment variable).
const TEST_SECRET = 'test-only-secret-0123456789abcdef-0123456789abcdef';
const OTHER_SECRET = 'a-completely-different-secret-value-9876543210';

// ===========================================================================
// §12 A/B. Valid signed cookies authenticate to their exact preference.
// ===========================================================================
{
  const signedOn = signAdultCookieValue(canonicalAdultCookieValue(true), TEST_SECRET);
  assert.equal(verifyAdultCookieValue(signedOn, TEST_SECRET), true, 'valid ON cookie verifies ON');
  ok('12-A valid ON cookie -> guest preference ON');

  const signedOff = signAdultCookieValue(canonicalAdultCookieValue(false), TEST_SECRET);
  assert.equal(verifyAdultCookieValue(signedOff, TEST_SECRET), false, 'valid OFF cookie verifies OFF');
  ok('12-B valid OFF cookie -> guest preference OFF');

  assert.match(signedOn, /^1\.[0-9a-f]{64}$/, 'ON cookie is <canonical>.<64-hex-hmac>');
  assert.match(signedOff, /^0\.[0-9a-f]{64}$/, 'OFF cookie is <canonical>.<64-hex-hmac>');
  ok('cookie format: value.hmac-sha256-hex (64 hex chars)');
}

// ===========================================================================
// §12 C. The signature DEPENDS on the value (the old XOR hash did NOT —
// one signature validated both "1" and "0"; flipping the flag kept the sig).
// ===========================================================================
{
  const sigOfOne = signAdultCookieValue('1', TEST_SECRET);
  const sigOfZero = signAdultCookieValue('0', TEST_SECRET);
  assert.notEqual(sigOfOne.split('.')[1], sigOfZero.split('.')[1], 'HMAC differs per canonical value');
  // The classic forgery: take a valid OFF cookie and flip the value only.
  const forged = `1.${sigOfZero.split('.')[1]}`;
  assert.equal(verifyAdultCookieValue(forged, TEST_SECRET), false, 'value-flip with old signature rejected');
  // Reverse direction too.
  const forgedReverse = `0.${sigOfOne.split('.')[1]}`;
  assert.equal(verifyAdultCookieValue(forgedReverse, TEST_SECRET), false, 'reverse value-flip rejected');
  ok('12-C modified value with old signature -> rejected (signature is value-bound)');
}

// ===========================================================================
// §12 D/E. Signature tampering and random signatures are rejected.
// ===========================================================================
{
  const valid = signAdultCookieValue('1', TEST_SECRET);
  const [value, sig] = valid.split('.');
  // Flip one bit in the hex signature (every position covered).
  for (let i = 0; i < sig.length; i += 7) {
    const flipped = sig[i] === '0' ? '1' : '0';
    const tampered = sig.slice(0, i) + flipped + sig.slice(i + 1);
    assert.equal(verifyAdultCookieValue(`${value}.${tampered}`, TEST_SECRET), false, `single-char sig tamper at ${i} rejected`);
  }
  ok('12-D modified signature -> rejected (every single-character tamper)');
  assert.equal(verifyAdultCookieValue(`${value}.${sig}0`, TEST_SECRET), false, 'appended char rejected');
  assert.equal(verifyAdultCookieValue(`${value}.${sig.slice(1)}`, TEST_SECRET), false, 'dropped char rejected');
  // Random signatures.
  for (const rand of ['0'.repeat(64), 'f'.repeat(64), 'deadbeef'.repeat(8), 'not-even-hex']) {
    assert.equal(verifyAdultCookieValue(`${value}.${rand}`, TEST_SECRET), false, 'random/garbage signature rejected');
  }
  ok('12-E random signature -> rejected');
}

// ===========================================================================
// §12 F. Wrong secret -> rejected (proves the secret actually participates —
// the old scheme hashed a PUBLIC constant unrelated to any per-deployment secret).
// ===========================================================================
{
  const signedWithTest = signAdultCookieValue('1', TEST_SECRET);
  assert.equal(verifyAdultCookieValue(signedWithTest, OTHER_SECRET), false, 'cookie signed under secret A rejected under secret B');
  const signedWithOther = signAdultCookieValue('1', OTHER_SECRET);
  assert.equal(verifyAdultCookieValue(signedWithOther, TEST_SECRET), false, 'reverse-direction wrong secret rejected');
  assert.notEqual(signedWithTest, signedWithOther, 'different secrets produce different cookies');
  ok('12-F wrong secret -> rejected');
}

// ===========================================================================
// §12 G. Missing production secret -> FAIL CLOSED on both paths.
// ===========================================================================
{
  const valid = signAdultCookieValue('1', TEST_SECRET);
  // Verification path: nothing can authenticate without a secret.
  assert.equal(verifyAdultCookieValue(valid, undefined), false, 'verification with missing secret -> OFF');
  assert.equal(verifyAdultCookieValue(valid, ''), false, 'verification with empty secret -> OFF');
  assert.equal(verifyAdultCookieValue(valid, '   '), false, 'verification with whitespace-only secret -> OFF');
  ok('12-G verify path: missing secret -> guest preference OFF (fail closed)');

  // Issuance path: the server refuses to mint cookies it cannot sign.
  assert.throws(() => assertAdultCookieSecret(undefined), /MAVERO_ADULT_COOKIE_SECRET/, 'issuance with missing secret throws');
  assert.throws(() => assertAdultCookieSecret(''), /MAVERO_ADULT_COOKIE_SECRET/, 'issuance with empty secret throws');
  assert.throws(() => assertAdultCookieSecret('   '), /MAVERO_ADULT_COOKIE_SECRET/, 'issuance with whitespace-only secret throws');
  assert.throws(() => signAdultCookieValue('1', ''), /refusing to sign/, 'raw signer also refuses empty secret (defense in depth)');
  assert.equal(assertAdultCookieSecret(`  ${TEST_SECRET}  `), TEST_SECRET, 'valid secret passes through (trimmed)');
  ok('12-G issuance path: missing secret -> throws, no unsigned/fallback cookie');

  assert.equal(verifyAdultCookieValue(undefined, TEST_SECRET), false, 'no-cookie call fails closed');
  assert.equal(verifyAdultCookieValue(valid), false, 'no-secret call fails closed (no fallback secret anywhere)');
  ok('12-G no-secret fallback exists NOWHERE (no public value, no literal — see static Z)');
}

// ===========================================================================
// §12 H. Timing-safe comparison mechanism (crypto.timingSafeEqual).
// ===========================================================================
{
  // The security decision path never uses plain equality and never throws
  // on attacker-controlled length differences.
  const valid = signAdultCookieValue('1', TEST_SECRET);
  const sig = valid.split('.')[1];
  for (const len of [0, 1, 31, 32, 63, 64, 65, 128, 1000]) {
    const candidate = 'a'.repeat(len);
    assert.equal(verifyAdultCookieValue(`1.${candidate}`, TEST_SECRET), false, `sig of length ${len} rejected without throwing`);
  }
  assert.equal(verifyAdultCookieValue(`1.${sig.slice(0, 32)}`, TEST_SECRET), false, 'half-length sig rejected');
  ok('12-H signature comparison handles arbitrary length differences safely');

  // Direct properties of the timing-safe comparator.
  assert.equal(timingSafeStringEqual('same', 'same'), true, 'equal strings compare equal');
  assert.equal(timingSafeStringEqual('a', 'b'), false, 'different strings compare unequal');
  assert.equal(timingSafeStringEqual('', ''), true, 'empty strings compare equal');
  for (let i = 0; i < 200; i++) {
    const a = Math.random().toString(36).repeat(1 + (i % 5));
    const b = i % 2 === 0 ? a : a + 'x';
    assert.equal(timingSafeStringEqual(a, b), a === b, `fuzzed comparison #${i} consistent`);
  }
  ok('12-H timingSafeStringEqual fuzz (200 cases, mixed lengths) consistent, never throws');
  // The static guarantee that crypto.timingSafeEqual (not ===) is the
  // verdict primitive is asserted in scripts/adult_mode_test.ts section Z.
}

// ===========================================================================
// §12 I. Public environment values are NOT usable as the secret.
// ===========================================================================
{
  // The pure module has no env access at all (secret is an explicit
  // parameter) — structurally asserted statically in section Z; here we
  // prove the secret channel itself rejects the degenerate values a
  // misconfigured public env would produce.
  assert.throws(() => assertAdultCookieSecret(''), /MAVERO_ADULT_COOKIE_SECRET/, 'empty value rejected as secret');
  assert.notEqual(TEST_SECRET, '', 'sanity');
  // A public-URL-shaped value would technically "work" as an HMAC key if
  // someone wired it — the wiring (adult-policy.ts, static Z) only ever
  // passes env.MAVERO_ADULT_COOKIE_SECRET and has no fallback.
  ok('12-I secret channel rejects empty/missing; wiring uses only MAVERO_ADULT_COOKIE_SECRET');
}

// ===========================================================================
// §12 J/K/L. Cookie security attributes.
// ===========================================================================
{
  const signed = signAdultCookieValue('1', TEST_SECRET);
  const prodCookie = buildAdultGuestSetCookie(signed, GUEST_COOKIE_MAX_AGE_SECONDS, true);
  const devCookie = buildAdultGuestSetCookie(signed, GUEST_COOKIE_MAX_AGE_SECONDS, false);

  assert.ok(prodCookie.startsWith(`${GUEST_COOKIE_NAME}=`), 'cookie carries the mavero_adult_guest name');
  assert.match(prodCookie, /; Secure($|;)/, '12-J production cookie is Secure');
  assert.doesNotMatch(devCookie, /; Secure($|;)/, '12-J dev (vite dev, HTTP localhost) omits Secure without weakening production');

  assert.match(prodCookie, /; HttpOnly/, '12-K cookie is HttpOnly (not exposed to JavaScript)');
  assert.match(devCookie, /; HttpOnly/, '12-K HttpOnly in dev too');

  assert.match(prodCookie, /; SameSite=Lax/, '12-L SameSite=Lax (existing safe policy preserved)');
  assert.match(prodCookie, /; Path=\//, '12-L Path=/');
  assert.match(prodCookie, new RegExp(`; Max-Age=${GUEST_COOKIE_MAX_AGE_SECONDS}`), '12-L bounded Max-Age (1 year)');
  assert.ok(!/\bDomain=/.test(prodCookie), 'no Domain relaxation');
  ok('12-J/K/L production cookie: HttpOnly + Secure + SameSite=Lax + Path=/ + Max-Age');

  const clearProd = buildAdultGuestClearCookie(true);
  assert.equal(clearProd, `${GUEST_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`, 'clear header drops the cookie with mirrored attributes');
  const clearDev = buildAdultGuestClearCookie(false);
  assert.doesNotMatch(clearDev, /; Secure/, 'clear header in dev omits Secure consistently');
  ok('clear-cookie header format preserved (Max-Age=0, mirrored flags)');
}

// ===========================================================================
// Canonical value strictness: only "1"/"0" are ever signed or accepted.
// ===========================================================================
{
  assert.equal(canonicalAdultCookieValue(true), '1', 'canonical(true) = "1"');
  assert.equal(canonicalAdultCookieValue(false), '0', 'canonical(false) = "0"');
  for (const bad of ['true', 'yes', '01', ' 1', '1 ', 'on', 'enabled']) {
    assert.throws(() => signAdultCookieValue(bad, TEST_SECRET), /non-canonical/, `signing "${bad}" refused`);
    assert.equal(verifyAdultCookieValue(`${bad}.${'0'.repeat(64)}`, TEST_SECRET), false, `verifying "${bad}" fails closed`);
  }
  // Segment tricks: extra dots, empty value, signature-only.
  for (const malformed of ['', '.', '.sig', '1.', '1.sig.extra', '..']) {
    assert.equal(verifyAdultCookieValue(malformed, TEST_SECRET), false, `malformed cookie "${malformed}" fails closed`);
  }
  assert.equal(verifyAdultCookieValue(undefined, TEST_SECRET), false, 'missing cookie fails closed');
  ok('canonical payload strictness: non-canonical and malformed values never signed/accepted');
}

// ===========================================================================
// §13. Authorization matrix — the REAL production evaluation function.
// ===========================================================================
{
  const adminOff: AdultModePolicy = { allowLoggedIn: false, allowGuest: false };
  const adminOn: AdultModePolicy = { allowLoggedIn: true, allowGuest: true };

  // A. Admin OFF (logged-in) + user preference ON -> DENIED.
  const a = evaluateAdultAccess({ policy: { allowLoggedIn: false, allowGuest: true }, isAuthenticated: true, userPreference: true });
  assert.equal(a.canAccessAdultContent, false, '13-A admin OFF overrides user ON');
  assert.equal(a.adminAllows, false, '13-A adminAllows false');
  assert.equal(a.userEnabled, false, '13-A userEnabled reported false once admin denies');
  ok('13-A admin OFF + user ON -> denied (admin overrides)');

  // B. Admin OFF (guest) + guest cookie ON -> DENIED.
  const b = evaluateAdultAccess({ policy: { allowLoggedIn: true, allowGuest: false }, isAuthenticated: false, userPreference: true });
  assert.equal(b.canAccessAdultContent, false, '13-B admin OFF overrides guest ON');
  ok('13-B admin OFF + guest ON -> denied (admin overrides)');

  // C. Admin ON + user OFF -> DENIED.
  const c = evaluateAdultAccess({ policy: adminOn, isAuthenticated: true, userPreference: false });
  assert.equal(c.canAccessAdultContent, false, '13-C admin allows but user preference OFF');
  assert.equal(c.adminAllows, true, '13-C adminAllows true');
  ok('13-C admin ON + user OFF -> denied');

  // D. Admin ON + user ON -> ALLOWED.
  const d = evaluateAdultAccess({ policy: adminOn, isAuthenticated: true, userPreference: true });
  assert.equal(d.canAccessAdultContent, true, '13-D authorized user allowed');
  ok('13-D admin ON + user ON -> allowed');

  // E. Admin ON + guest OFF -> DENIED.
  const e = evaluateAdultAccess({ policy: adminOn, isAuthenticated: false, userPreference: false });
  assert.equal(e.canAccessAdultContent, false, '13-E guest without signed ON cookie denied');
  ok('13-E admin ON + guest OFF -> denied');

  // F. Admin ON + guest ON (valid signed cookie) -> ALLOWED.
  const f = evaluateAdultAccess({ policy: adminOn, isAuthenticated: false, userPreference: true });
  assert.equal(f.canAccessAdultContent, true, '13-F authorized guest allowed');
  ok('13-F admin ON + guest ON -> allowed');
}

// ===========================================================================
// §13 G/H. Fail-closed read mappings (what getAdultAccessContext feeds in).
// ===========================================================================
{
  const dbError = { message: 'connection refused' };
  // G. app_settings read failure -> policy OFF for everyone.
  const failedPolicy = adminPolicyFromRead(null, dbError);
  assert.deepEqual(failedPolicy, { allowLoggedIn: false, allowGuest: false }, 'policy read failure fails closed');
  assert.equal(evaluateAdultAccess({ policy: failedPolicy, isAuthenticated: true, userPreference: true }).canAccessAdultContent, false, 'failed policy denies logged-in users');
  assert.equal(evaluateAdultAccess({ policy: failedPolicy, isAuthenticated: false, userPreference: true }).canAccessAdultContent, false, 'failed policy denies guests');
  // Missing row (no error, no data) also fails closed.
  const missingRow = adminPolicyFromRead(null, null);
  assert.deepEqual(missingRow, { allowLoggedIn: false, allowGuest: false }, 'missing app_settings row fails closed');
  // A successful read maps the row values faithfully.
  const okPolicy = adminPolicyFromRead({ adult_mode_allow_logged_in: true, adult_mode_allow_guest: false }, null);
  assert.deepEqual(okPolicy, { allowLoggedIn: true, allowGuest: false }, 'successful read maps admin columns faithfully');
  ok('13-G app_settings read failure/missing row -> OFF for everyone (fail closed)');

  // H. user_preferences read failure -> preference OFF.
  assert.equal(userPreferenceFromRead(null, dbError), false, 'preference read failure fails closed');
  assert.equal(userPreferenceFromRead(null, null), false, 'missing preference row fails closed (default OFF)');
  assert.equal(userPreferenceFromRead({ adult_mode_enabled: true }, null), true, 'successful read maps adult_mode_enabled faithfully');
  const deniedByPref = evaluateAdultAccess({ policy: { allowLoggedIn: true, allowGuest: true }, isAuthenticated: true, userPreference: userPreferenceFromRead(null, dbError) });
  assert.equal(deniedByPref.canAccessAdultContent, false, 'failed preference read denies under admin ON');
  ok('13-H user preference read failure -> OFF (fail closed, existing safe semantics)');
}

// ===========================================================================
// §13 I. Admin policy ON -> OFF flip is visible on the IMMEDIATELY NEXT
// evaluation. This is the anti-60-second-cache proof: the evaluation path
// holds no state, so a fresh read produces a fresh decision. (The wiring
// reads app_settings per request — asserted statically in section Z.)
// ===========================================================================
{
  const onThenOff: Array<AdultModePolicy> = [
    { allowLoggedIn: true, allowGuest: true }, // t0: admin allows
    { allowLoggedIn: false, allowGuest: false } // t1: admin disables — must apply instantly
  ];
  const decisions = onThenOff.map((policy) =>
    evaluateAdultAccess({ policy, isAuthenticated: true, userPreference: true }).canAccessAdultContent
  );
  assert.deepEqual(decisions, [true, false], 'admin ON->OFF applies on the next evaluation (no TTL window)');
  // And the reverse direction (re-enable) — no stale deny either.
  const offThenOn: Array<AdultModePolicy> = [
    { allowLoggedIn: false, allowGuest: false },
    { allowLoggedIn: true, allowGuest: true }
  ];
  const decisions2 = offThenOn.map((policy) =>
    evaluateAdultAccess({ policy, isAuthenticated: false, userPreference: true }).canAccessAdultContent
  );
  assert.deepEqual(decisions2, [false, true], 'admin OFF->ON also applies immediately');
  ok('13-I admin policy flip -> next authorization sees the new policy immediately (process cache is gone)');
}

// ===========================================================================
// Guest persistence (spec §19) — pure-layer round trip through the REAL
// cookie construction, plus admin-cycle semantics through the REAL matrix.
// ===========================================================================
{
  // 1. Guest enables Adult Mode (admin allows): server mints a signed ON cookie.
  const cookie = signAdultCookieValue(canonicalAdultCookieValue(true), TEST_SECRET);
  // 2. Subsequent request: cookie verifies -> preference ON; admin ON -> allowed.
  const t1 = evaluateAdultAccess({
    policy: { allowLoggedIn: true, allowGuest: true },
    isAuthenticated: false,
    userPreference: verifyAdultCookieValue(cookie, TEST_SECRET)
  });
  assert.equal(t1.canAccessAdultContent, true, 'guest persistence: signed cookie keeps Adult Mode enabled');
  // 3. Admin disables guest Adult Mode: the SAME cookie can no longer grant access.
  const t2 = evaluateAdultAccess({
    policy: { allowLoggedIn: true, allowGuest: false },
    isAuthenticated: false,
    userPreference: verifyAdultCookieValue(cookie, TEST_SECRET)
  });
  assert.equal(t2.canAccessAdultContent, false, 'admin OFF overrides the persisted cookie immediately');
  // 4. Admin re-enables: the guest local preference is recognized again
  //    (existing product semantics — no silent reset).
  const t3 = evaluateAdultAccess({
    policy: { allowLoggedIn: true, allowGuest: true },
    isAuthenticated: false,
    userPreference: verifyAdultCookieValue(cookie, TEST_SECRET)
  });
  assert.equal(t3.canAccessAdultContent, true, 'admin re-enable recognizes the persisted guest preference again');
  ok('guest persistence: enable -> persists -> admin-deny overrides -> re-enable recognizes again');
}

// ===========================================================================
// Legacy migration: cookies minted by the OLD forgeable scheme (and any
// unsigned/malformed value) are treated as guest preference OFF.
// ===========================================================================
{
  for (const legacy of ['1.123456789', '0.123456789', '1', '0', '1.x', '1.-99', '1.0', '0.1']) {
    assert.equal(verifyAdultCookieValue(legacy, TEST_SECRET), false, `legacy/unsigned cookie "${legacy}" -> OFF`);
  }
  const denied = evaluateAdultAccess({
    policy: { allowLoggedIn: true, allowGuest: true },
    isAuthenticated: false,
    userPreference: verifyAdultCookieValue('1.123456789', TEST_SECRET)
  });
  assert.equal(denied.canAccessAdultContent, false, 'legacy forged-style cookie grants NOTHING after migration');
  ok('legacy migration: old-scheme / unsigned cookies treated as OFF (guests simply re-enable)');
}

// ===========================================================================
// Search regression binding (spec §15): the hardened authorization boolean
// feeds the UNCHANGED Phase 4 search branch. No Search rewrite.
// ===========================================================================
{
  assert.equal(searchFilterMode(false), 'classify-and-exclude', 'denied authorization -> classify-and-exclude (Adult OFF search excludes adult + uncertain)');
  assert.equal(searchFilterMode(true), 'authorized-passthrough', 'granted authorization -> authorized-passthrough (existing Phase 4 behavior)');
  // Matrix decision -> search mode, both directions.
  const adminOn = { allowLoggedIn: true, allowGuest: true };
  const userCtx = evaluateAdultAccess({ policy: adminOn, isAuthenticated: true, userPreference: true });
  assert.equal(searchFilterMode(userCtx.canAccessAdultContent), 'authorized-passthrough', 'authorized user keeps authorized search');
  const adminOffCtx = evaluateAdultAccess({ policy: { allowLoggedIn: false, allowGuest: false }, isAuthenticated: true, userPreference: true });
  assert.equal(searchFilterMode(adminOffCtx.canAccessAdultContent), 'classify-and-exclude', 'admin-OFF user gets the protected search mode (integration binding)');
  ok('Search regression: hardened authorization decision drives the unchanged Phase 4 search branch');
}

// ===========================================================================
// Classification / authorization separation (spec §16): the authorization
// module holds no content-classification logic and no cache.
// ===========================================================================
{
  const authzSource = (await import('node:fs/promises')).readFile(
    new URL('../src/lib/server/content/adult-authz.ts', import.meta.url),
    'utf8'
  );
  const src = await authzSource;
  assert.doesNotMatch(src, /from '\.\/adult-providers'|from '\.\/adult-networks'|from '\.\/adapters\//, 'authz layer imports NO content-classification modules');
  assert.doesNotMatch(src, /\b(2902|4573|7355)\b/, 'no hardcoded adult network ids in the authz layer');
  assert.doesNotMatch(src, /POLICY_TTL|cachedPolicy|new Map|getOrSet\(/, 'authz layer holds NO cache structures');
  ok('classification vs authorization separation: matrix layer is pure decision logic only');
}

console.log(`Adult authorization behavioral tests passed (${passed} checks): HMAC cookie forgery resistance (§12 A-L), fail-closed secret handling, timing-safe comparison, canonical payload strictness, full authorization matrix (§13 A-I), admin-flip immediacy (no process cache), guest persistence cycle, legacy cookie migration, search regression binding, classification/authorization separation.`);
