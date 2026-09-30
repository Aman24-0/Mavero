import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseDeviceMetadata,
  ensureDeviceIdCookie,
  readDeviceHintCookie,
  getOrCreateDeviceId,
  DEVICE_ID_COOKIE,
  DEVICE_HINT_COOKIE,
} from '../src/lib/server/auth/device-metadata.ts';
import { extractSessionId } from '../src/lib/server/auth/jwt-session-id.ts';
import {
  registerCurrentSession,
  listUserSessions,
  revokeSession,
  revokeAllOtherSessions,
  lookupSessionRevocationState,
} from '../src/lib/server/auth/device-sessions.ts';
import { isBigScreen, isQrScannerDevice, deviceTypeLabel } from '../src/lib/shared/device-class.ts';

// ============================================================
// Newtask §34 test plan — sections A–E + §21 heartbeat.
//
// These are DETERMINISTIC tests. The Supabase service is exercised
// through a faithful in-memory PostgREST-surface fake whose
// register_device_session semantics mirror the migration SQL
// (20260930000000_register_device_session_rpc.sql); every SQL branch
// the fake implements is ALSO pinned by a source-contract assertion
// below, so the lifecycle is verified from both sides. No live DB.
// ============================================================

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ============================================================
// Fake PostgREST-style admin client (deterministic, in-memory)
// ============================================================

type Row = {
  id: string;
  user_id: string;
  supabase_session_id: string;
  device_id: string;
  device_type: string;
  device_name: string;
  browser: string | null;
  os: string | null;
  platform: string | null;
  ip_hash: string | null;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
};

type FilterVal = string | null | { $ne: unknown } | { $gt: unknown };

/**
 * Deterministic in-memory PostgREST-surface fake. Implements EXACTLY the
 * supabase-js surface used by device-sessions.ts:
 *   - admin.rpc('register_device_session', {...}) with the documented
 *     migration semantics (revoked → empty; fresh → no-op; stale →
 *     heartbeat; missing → INSERT registered=true)
 *   - from('device_sessions').select(...).eq/neq/is/gt(...).order(...)
 *     [awaited or .maybeSingle()/.single()]
 *   - from('device_sessions').update(patch).eq/neq/is(...) [awaited]
 *
 * The operator filters ($ne / $gt) behave like PostgREST, so behavioral
 * scenarios (revoke-all, stale filter) exercise real filter semantics.
 */
function createAdmin(initialRows: Row[]) {
  const rows: Row[] = [...initialRows];
  const rpcCalls: Array<Record<string, unknown>> = [];

  const rowMatches = (r: Row, filters: Array<[string, FilterVal]>) =>
    filters.every(([col, val]) => {
      const actual = r[col as keyof Row];
      if (val !== null && typeof val === 'object' && '$ne' in (val as object)) return actual !== (val as { $ne: unknown }).$ne;
      if (val !== null && typeof val === 'object' && '$gt' in (val as object)) {
        return String(actual) > String((val as { $gt: unknown }).$gt);
      }
      return actual === val;
    });

  function makeBuilder(kind: 'select' | 'update', patch: Partial<Row> | null) {
    const filters: Array<[string, FilterVal]> = [];
    const builder: Record<string, unknown> = {};
    const run = () => {
      if (kind === 'update') {
        for (const r of rows) if (rowMatches(r, filters)) Object.assign(r, patch);
        return { data: null, error: null };
      }
      return { data: rows.filter((r) => rowMatches(r, filters)), error: null };
    };
    builder.eq = (col: string, val: unknown) => { filters.push([col, val as FilterVal]); return builder; };
    builder.neq = (col: string, val: unknown) => { filters.push([col, { $ne: val }]); return builder; };
    builder.is = (col: string, val: unknown) => { filters.push([col, val as FilterVal]); return builder; };
    builder.gt = (col: string, val: unknown) => { filters.push([col, { $gt: val }]); return builder; };
    builder.order = () => builder;
    builder.maybeSingle = () =>
      Promise.resolve(run()).then((r) => ({ data: (r.data as Row[] | null)?.[0] ?? null, error: null }));
    builder.single = () =>
      Promise.resolve(run()).then((r) => ({ data: (r.data as Row[] | null)?.[0] ?? null, error: null }));
    builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(run()).then(resolve, reject);
    return builder;
  }

  const admin = {
    rows: () => rows,
    rpcCalls: () => rpcCalls,
    rpc: async (fn: string, p: Record<string, unknown>): Promise<{ data: unknown; error: { name: string } | null }> => {
      rpcCalls.push({ fn, ...p });
      if (fn !== 'register_device_session') return { data: null, error: { name: 'ENOTSUP' } };
      // Mirrors migration 20260930000000 semantics exactly:
      //   revoked row      → empty result (NEVER resurrect)
      //   fresh heartbeat  → row, no write
      //   stale heartbeat  → row + last_seen_at update
      //   no row           → INSERT, registered=true
      const now = typeof p.p_now === 'string' ? p.p_now : new Date().toISOString();
      const existing = rows.find(
        (r) => r.user_id === p.p_user_id && r.supabase_session_id === p.p_supabase_session_id
      );
      if (existing) {
        if (existing.revoked_at !== null) return { data: [], error: null };
        const ageMs = new Date(now).getTime() - new Date(existing.last_seen_at).getTime();
        if (ageMs < (p.p_heartbeat_interval_ms as number)) {
          return { data: [{ ...existing, registered: false }], error: null };
        }
        existing.last_seen_at = now;
        return { data: [{ ...existing, registered: false }], error: null };
      }
      const row: Row & { registered?: boolean } = {
        id: crypto.randomUUID(),
        user_id: p.p_user_id as string,
        supabase_session_id: p.p_supabase_session_id as string,
        device_id: p.p_device_id as string,
        device_type: p.p_device_type as string,
        device_name: p.p_device_name as string,
        browser: (p.p_browser as string | null) ?? null,
        os: (p.p_os as string | null) ?? null,
        platform: (p.p_platform as string | null) ?? null,
        ip_hash: (p.p_ip_hash as string | null) ?? null,
        created_at: now,
        last_seen_at: now,
        revoked_at: null,
        registered: true,
      };
      rows.push(row);
      return { data: [row], error: null };
    },
    from: (table: string) => {
      assert.equal(table, 'device_sessions', 'fake only models device_sessions');
      return {
        select: () => makeBuilder('select', null),
        update: (patch: Partial<Row>) => makeBuilder('update', patch),
      };
    },
  };
  // The service only uses the documented surface; cast away fakeness.
  return admin as unknown as import('../src/lib/server/supabase/admin.ts').SupabaseAdminClient & {
    rows: () => Row[];
    rpcCalls: () => Array<Record<string, unknown>>;
  };
}

const U1 = '11111111-1111-1111-1111-111111111111';
const S1 = 'aaaa1111-0000-0000-0000-000000000001';
const S2 = 'aaaa2222-0000-0000-0000-000000000002';
const S3 = 'aaaa3333-0000-0000-0000-000000000003';

function makeRow(over: Partial<Row>): Row {
  return {
    id: crypto.randomUUID(),
    user_id: U1,
    supabase_session_id: S1,
    device_id: 'device-a',
    device_type: 'mobile',
    device_name: 'Android • Chrome',
    browser: 'Chrome',
    os: 'Android',
    platform: 'Android',
    ip_hash: null,
    created_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    revoked_at: null,
    ...over,
  };
}

const PHONE_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const PHONE_BRAVE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const PHONE_BRAVE_CH =
  '"Chromium";v="130", "Brave";v="130", "Not?A_Brand";v="99"';
const WINDOWS_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const WINDOWS_BRAVE_CH =
  '"Brave";v="130", "Chromium";v="130", "Not?A_Brand";v="99"';
const IPHONE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD_SAFARI_UA =
  'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const MAC_SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const MAC_DESKTOP_MODE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const WIN_FIREFOX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0';

const meta = (ua: string, hints?: Parameters<typeof parseDeviceMetadata>[1]) => parseDeviceMetadata(ua, hints);

// ============================================================
// A. DEVICE REGISTRATION (tests 1–8, Newtask §34)
// ============================================================
{
  console.log('A. Device registration');

  // A1: first password login creates session row.
  {
    const admin = createAdmin([]);
    const row = await registerCurrentSession(admin, {
      userId: U1,
      supabaseSessionId: S1,
      deviceId: 'device-a',
      metadata: meta(PHONE_CHROME_UA),
    });
    ok(row !== null, 'A1: first login creates a session row');
    ok(admin.rows().length === 1, 'A1: exactly one registry row after first login');
    ok(row?.registered === true, 'A1: RPC flags a fresh INSERT');
    ok(row?.device_name === 'Android • Chrome', 'A1: real device name from User-Agent');
  }

  // A2: second login in another browser creates another row.
  {
    const admin = createAdmin([makeRow({ supabase_session_id: S1, device_id: 'device-a' })]);
    const row = await registerCurrentSession(admin, {
      userId: U1,
      supabaseSessionId: S2,
      deviceId: 'device-b',
      metadata: meta(WINDOWS_CHROME_UA),
    });
    ok(row !== null && row.registered === true, 'A2: second browser login registers a new row');
    ok(admin.rows().length === 2, 'A2: registry now holds two rows');
    ok(admin.rows().some((r) => r.supabase_session_id === S2 && r.device_name === 'Windows • Chrome'), 'A2: laptop row has real metadata');
  }

  // A3: phone Chrome and phone Brave create separate sessions (Brave via sec-ch-ua).
  {
    const admin = createAdmin([]);
    await registerCurrentSession(admin, { userId: U1, supabaseSessionId: S1, deviceId: 'd1', metadata: meta(PHONE_CHROME_UA) });
    await registerCurrentSession(admin, { userId: U1, supabaseSessionId: S2, deviceId: 'd2', metadata: meta(PHONE_BRAVE_UA, { clientHintsBrands: PHONE_BRAVE_CH }) });
    const names = admin.rows().map((r) => r.device_name).sort();
    ok(names[0] === 'Android • Brave' && names[1] === 'Android • Chrome', `A3: Chrome and Brave are distinct (${names.join(', ')})`);
  }

  // A4: laptop Brave creates a separate session.
  {
    const admin = createAdmin([]);
    await registerCurrentSession(admin, { userId: U1, supabaseSessionId: S3, deviceId: 'd3', metadata: meta(WINDOWS_CHROME_UA, { clientHintsBrands: WINDOWS_BRAVE_CH }) });
    ok(admin.rows()[0].device_name === 'Windows • Brave', 'A4: laptop Brave labelled via sec-ch-ua');
  }

  // A5: same browser logout/login creates a NEW session_id row.
  {
    const admin = createAdmin([makeRow({ supabase_session_id: S1, revoked_at: new Date().toISOString() })]);
    const row = await registerCurrentSession(admin, {
      userId: U1,
      supabaseSessionId: S2, // brand-new Supabase session after re-login
      deviceId: 'device-a',
      metadata: meta(PHONE_CHROME_UA),
    });
    ok(row !== null && row.registered === true, 'A5: re-login creates a NEW row (new session identity)');
    ok(admin.rows().length === 2, 'A5: old revoked row preserved + new active row');
    const active = await listUserSessions(admin, U1);
    ok(active.length === 1 && active[0].supabase_session_id === S2, 'A5: only the new session is listed active');
  }

  // A6: old revoked session NEVER resurrects.
  {
    const admin = createAdmin([makeRow({ supabase_session_id: S1, revoked_at: new Date().toISOString() })]);
    const row = await registerCurrentSession(admin, {
      userId: U1,
      supabaseSessionId: S1, // same session id tries to re-register
      deviceId: 'device-a',
      metadata: meta(PHONE_CHROME_UA),
    });
    ok(row === null, 'A6: revoked session re-registration returns null (no resurrect)');
    ok(admin.rows().length === 1 && admin.rows()[0].revoked_at !== null, 'A6: registry row stays revoked');
  }

  // A7: last_seen_at updates after heartbeat interval.
  {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const admin = createAdmin([makeRow({ supabase_session_id: S1, last_seen_at: stale })]);
    const before = admin.rows()[0].last_seen_at;
    await new Promise((r) => setTimeout(r, 5));
    const row = await registerCurrentSession(admin, {
      userId: U1,
      supabaseSessionId: S1,
      deviceId: 'device-a',
      metadata: meta(PHONE_CHROME_UA),
    });
    ok(row !== null, 'A7: heartbeat registration returns the row');
    ok(new Date(admin.rows()[0].last_seen_at).getTime() > new Date(before).getTime(), 'A7: last_seen_at advanced after interval');
  }

  // A8: no duplicate rows for the same session_id (fresh heartbeat = no-op).
  {
    const admin = createAdmin([makeRow({ supabase_session_id: S1 })]);
    const row = await registerCurrentSession(admin, {
      userId: U1,
      supabaseSessionId: S1,
      deviceId: 'device-a',
      metadata: meta(PHONE_CHROME_UA),
    });
    ok(row !== null && row.registered === false, 'A8: fresh heartbeat is a no-op (registered=false)');
    ok(admin.rows().length === 1, 'A8: no duplicate row created');
  }
}

// ============================================================
// §21 heartbeat scenarios (1–6, explicit)
// ============================================================
{
  console.log('Heartbeat (Newtask §21)');

  // 1. first request creates row — covered by A1.
  // 2. second request inside heartbeat interval does not create a duplicate.
  {
    const admin = createAdmin([]);
    await registerCurrentSession(admin, { userId: U1, supabaseSessionId: S1, deviceId: 'd', metadata: meta(PHONE_CHROME_UA) });
    await registerCurrentSession(admin, { userId: U1, supabaseSessionId: S1, deviceId: 'd', metadata: meta(PHONE_CHROME_UA) });
    ok(admin.rows().length === 1, 'H2: second request inside interval → no duplicate');
  }

  // 3. after the interval, last_seen_at updates.
  {
    const admin = createAdmin([makeRow({ supabase_session_id: S1, last_seen_at: new Date(Date.now() - 6 * 60 * 1000).toISOString() })]);
    const before = admin.rows()[0].last_seen_at;
    await registerCurrentSession(admin, { userId: U1, supabaseSessionId: S1, deviceId: 'd', metadata: meta(PHONE_CHROME_UA) });
    ok(admin.rows()[0].last_seen_at !== before, 'H3: last_seen_at updated after interval');
  }

  // 4. revoked session does not reappear.
  {
    const admin = createAdmin([makeRow({ supabase_session_id: S1, revoked_at: new Date().toISOString() })]);
    await registerCurrentSession(admin, { userId: U1, supabaseSessionId: S1, deviceId: 'd', metadata: meta(PHONE_CHROME_UA) });
    const listed = await listUserSessions(admin, U1);
    ok(listed.length === 0, 'H4: revoked session never reappears in the active list');
  }

  // 5. new Supabase session creates a new row — covered by A5.

  // 6. two sessions on the same device are independent.
  {
    const admin = createAdmin([]);
    await registerCurrentSession(admin, { userId: U1, supabaseSessionId: S1, deviceId: 'same-device', metadata: meta(PHONE_CHROME_UA) });
    await registerCurrentSession(admin, { userId: U1, supabaseSessionId: S2, deviceId: 'same-device', metadata: meta(PHONE_CHROME_UA) });
    const listed = await listUserSessions(admin, U1);
    ok(listed.length === 2, 'H6: two session_ids on one device are two rows');
    ok(new Set(listed.map((r) => r.supabase_session_id)).size === 2, 'H6: rows are independently identified by session_id');
  }
}

// ============================================================
// B. METADATA (tests 9–16, Newtask §34 + §6)
// ============================================================
{
  console.log('B. Device metadata');

  const androidChrome = meta(PHONE_CHROME_UA);
  ok(androidChrome.deviceType === 'mobile' && androidChrome.browser === 'Chrome' && androidChrome.os === 'Android', 'B9: Android Chrome → mobile/Chrome/Android');
  ok(androidChrome.deviceName === 'Android • Chrome', 'B9: Android Chrome display name');

  const androidBrave = meta(PHONE_BRAVE_UA, { clientHintsBrands: PHONE_BRAVE_CH });
  ok(androidBrave.browser === 'Brave' && androidBrave.deviceName === 'Android • Brave', 'B10: Android Brave via sec-ch-ua brands header');

  const iphoneSafari = meta(IPHONE_SAFARI_UA);
  ok(iphoneSafari.deviceType === 'mobile' && iphoneSafari.browser === 'Safari' && iphoneSafari.os === 'iOS', 'B11: iPhone Safari → mobile/Safari/iOS');

  const ipadSafari = meta(IPAD_SAFARI_UA);
  ok(ipadSafari.deviceType === 'tablet' && ipadSafari.os === 'iOS', 'B12: iPad Safari → tablet/iOS');

  const ipadDesktopMode = meta(MAC_DESKTOP_MODE_UA, { touchCapable: true });
  ok(ipadDesktopMode.deviceType === 'tablet' && ipadDesktopMode.os === 'iPadOS', 'B12b: iPad-as-Mac (touch hint) → tablet/iPadOS');

  const winChrome = meta(WINDOWS_CHROME_UA);
  ok(winChrome.deviceType === 'desktop' && winChrome.browser === 'Chrome' && winChrome.os === 'Windows', 'B13: Windows Chrome → desktop/Chrome/Windows');

  const winBrave = meta(WINDOWS_CHROME_UA, { clientHintsBrands: WINDOWS_BRAVE_CH });
  ok(winBrave.browser === 'Brave' && winBrave.deviceName === 'Windows • Brave', 'B14: Windows Brave via sec-ch-ua');

  const macSafari = meta(MAC_SAFARI_UA);
  ok(macSafari.deviceType === 'desktop' && macSafari.browser === 'Safari' && macSafari.os === 'macOS', 'B15: macOS Safari → desktop/Safari/macOS');

  const firefox = meta(WIN_FIREFOX_UA);
  ok(firefox.deviceType === 'desktop' && firefox.browser === 'Firefox', 'B16a: desktop Firefox detected');

  const unknown = meta('some-weird-client/1.0');
  ok(unknown.deviceType === 'unknown' && unknown.deviceName === 'Unknown device' && unknown.browser === null, 'B16b: unknown UA → unknown/null browser');

  // No hardcoded fallback: same parser, different inputs → different names.
  ok(androidChrome.deviceName !== winChrome.deviceName && winChrome.deviceName !== macSafari.deviceName, 'B: device names derive from the UA (no hardcoded single label)');

  // Device-id cookie helper (Newtask §5).
  {
    let setCalls: Array<{ value: string; options: Record<string, unknown> }> = [];
    const existing = ensureDeviceIdCookie('abcdefghij', (v, o) => { setCalls.push({ value: v, options: o }); }, true);
    ok(existing === 'abcdefghij' && setCalls.length === 0, '§5: existing valid device-id cookie is reused (no write)');
    const fresh = ensureDeviceIdCookie(undefined, (v, o) => { setCalls.push({ value: v, options: o }); }, true);
    ok(fresh.length >= 8 && setCalls.length === 1, '§5: missing cookie → generated once');
    const opts = setCalls[0].options as { path: string; httpOnly: boolean; sameSite: string; maxAge: number; secure: boolean };
    ok(opts.path === '/' && opts.httpOnly === true && opts.sameSite === 'lax' && opts.maxAge === 31536000 && opts.secure === true, '§5: cookie flags path/httpOnly/lax/1yr/secure');
    ok(DEVICE_ID_COOKIE === 'mavero:device-id', '§5: device-id cookie name constant');
    ok(readDeviceHintCookie('tablet') === true && readDeviceHintCookie('desktop') === false && readDeviceHintCookie(undefined) === false, '§5: touch hint cookie parser');
    ok(getOrCreateDeviceId('short') !== 'short', '§5: too-short existing cookie is regenerated');
  }
}

// ============================================================
// C. LOGOUT (tests 17–21, Newtask §34 + §13)
// ============================================================
{
  console.log('C. Logout');

  const signOut = read('src/routes/auth/sign-out/+server.ts');

  // 17. local sign-out revokes the current session only.
  ok(signOutSrcHasLocalScope(), 'C17: signOut uses { scope: \'local\' }');
  ok(!/signOut\(\)\s*;/.test(signOut), 'C17b: no scope-less signOut() call remains');

  // 17b. registry row for current session revoked BEFORE signOut.
  const revokeIdx = signOut.indexOf('await revokeSession');
  const signOutIdx = signOut.indexOf('auth.signOut(');
  ok(revokeIdx !== -1 && signOutIdx !== -1 && revokeIdx < signOutIdx, 'C17c: registry revocation precedes Supabase signOut');

  // 18. other sessions remain authenticated (endpoint semantics).
  {
    const admin = createAdmin([
      makeRow({ supabase_session_id: S1 }),
      makeRow({ supabase_session_id: S2 }),
      makeRow({ supabase_session_id: S3 }),
    ]);
    const success = await revokeSession(admin, U1, S1);
    ok(success === true, 'C18a: current session revocation succeeds');
    const others = await listUserSessions(admin, U1);
    ok(others.length === 2 && others.every((r) => r.supabase_session_id !== S1), 'C18b: other sessions remain active');
  }

  // 19–21. cache invalidation + controlled error paths (source contract).
  ok(signOut.includes('invalidateRevocationCache(supabaseSessionId)'), 'C21: sign-out invalidates the revocation cache');
  ok(signOut.includes('cache-control\': \'no-store\'') || signOut.includes('cache-control": "no-store"') || signOut.includes("'cache-control': 'no-store'"), 'C19: sign-out responses are no-store');
  ok(signOut.includes('redirect(303'), 'C: sign-out redirects after cleanup');
}

function signOutSrcHasLocalScope(): boolean {
  const src = read('src/routes/auth/sign-out/+server.ts');
  return /signOut\(\{\s*scope:\s*['"]local['"]\s*\}\)/.test(src);
}

// ============================================================
// D. REVOKE (tests 22–25, Newtask §34 + §14)
// ============================================================
{
  console.log('D. Revoke');

  // 22. selected session revoked; 23. others unaffected.
  {
    const admin = createAdmin([
      makeRow({ supabase_session_id: S1 }),
      makeRow({ supabase_session_id: S2 }),
      makeRow({ supabase_session_id: S3 }),
    ]);
    const success = await revokeSession(admin, U1, S2);
    ok(success, 'D22: revoke succeeds for the selected session');
    const remaining = await listUserSessions(admin, U1);
    ok(remaining.length === 2 && remaining.every((r) => r.supabase_session_id !== S2), 'D23: other sessions unaffected');
  }

  // 24. revoked session rejected by hooks (source contract).
  const hooks = read('src/hooks.server.ts');
  ok(hooks.includes('isSessionRevoked('), 'D24a: hooks consult the revocation cache/DB');
  ok(/if\s*\(\s*revoked\s*\)\s*\{[\s\S]*?sessionRevoked\s*=\s*true/.test(hooks), 'D24b: revoked session flips sessionRevoked');

  // 25. revoked session cannot re-register.
  ok(/if\s*\(\s*!sessionRevoked\s*&&\s*auth\.session\s*&&\s*auth\.user/.test(hooks), 'D25a: registration guarded by !sessionRevoked');
  const rpc = read('supabase/migrations/20260930000000_register_device_session_rpc.sql');
  ok(rpc.includes('if v_row.revoked_at is not null then') && rpc.includes('return;'), 'D25b: RPC refuses to resurrect revoked rows');

  // Revoke endpoint contract (Newtask §14).
  const revokeApi = read('src/routes/api/account/sessions/revoke/+server.ts');
  ok(revokeApi.includes('.eq(\'user_id\', user.id)'), 'D: revoke scoped to the authenticated user');
  ok(revokeApi.includes('invalidateRevocationCache'), 'D: revoke invalidates the cache');
  ok(revokeApi.includes('Use sign out to end your current session'), 'D: current session cannot be revoked via the API');
}

// ============================================================
// E. SIGN OUT ALL (tests 26–28, Newtask §34 + §15)
// ============================================================
{
  console.log('E. Sign out all');

  // 26. exact semantics: all OTHER sessions revoked; current preserved.
  {
    const admin = createAdmin([
      makeRow({ supabase_session_id: S1 }),
      makeRow({ supabase_session_id: S2 }),
      makeRow({ supabase_session_id: S3 }),
    ]);
    const { count, revokedSessionIds } = await revokeAllOtherSessions(admin, U1, S1);
    ok(count === 2 && revokedSessionIds.includes(S2) && revokedSessionIds.includes(S3), 'E26a: all other sessions revoked');
    ok(!revokedSessionIds.includes(S1), 'E26b: current session is preserved');
    const remaining = await listUserSessions(admin, U1);
    ok(remaining.length === 1 && remaining[0].supabase_session_id === S1, 'E26c: only the current session remains active');
  }

  // 27. affected sessions revoked — covered above.

  // 28. UI wording matches semantics (button + dialog + endpoint).
  const account = read('src/routes/account/+page.svelte');
  ok(account.includes('Sign out all other devices'), 'E28a: button says "Sign out all other devices"');
  ok(!account.includes('>Sign out all devices<'), 'E28b: ambiguous old wording removed');
  const revokeAllApi = read('src/routes/api/account/sessions/revoke-all/+server.ts');
  ok(revokeAllApi.includes('.neq(\'supabase_session_id\', currentSessionId)'), 'E28c: endpoint revokes all EXCEPT current');
}

// ============================================================
// STALE SESSION CLEANUP (Newtask §20)
// ============================================================
{
  console.log('Stale sessions (Newtask §20)');

  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const admin = createAdmin([
    makeRow({ supabase_session_id: S1, last_seen_at: new Date().toISOString() }),
    makeRow({ supabase_session_id: S2, last_seen_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() }),
    makeRow({ supabase_session_id: S3, last_seen_at: new Date(Date.now() - THIRTY_DAYS - 24 * 60 * 60 * 1000).toISOString() }),
  ]);
  const listed = await listUserSessions(admin, U1);
  ok(listed.length === 2 && listed.every((r) => r.supabase_session_id !== S3), '§20: stale row (31d) hidden from the active list');
  ok(admin.rows().length === 3, '§20: stale row is NOT deleted (audit history preserved)');

  const service = read('src/lib/server/auth/device-sessions.ts');
  ok(service.includes('STALE_SESSION_RETENTION_MS') && service.includes('.gt(\'last_seen_at\', staleCutoff)'), '§20: retention threshold enforced in the listing query');
}

// ============================================================
// SESSION REGISTRATION RELIABILITY (Newtask §3/§22 — source contract)
// ============================================================
{
  console.log('Registration reliability (Newtask §3/§22)');

  const hooks = read('src/hooks.server.ts');
  ok(!hooks.includes('void registerCurrentSession'), '§3a: registration is NOT fire-and-forget');
  ok(/await\s+awaitWithTimeout\(\s*\n?\s*registerCurrentSession/.test(hooks), '§3b: registration awaited via awaitWithTimeout');
  ok(hooks.includes('REGISTRATION_TIMEOUT_MS = 1500'), '§3c: bounded 1500ms registration timeout');
  ok(hooks.includes('Registration timed out (non-blocking)'), '§3d: timeout logged safely, auth continues');
  ok(hooks.includes('[DeviceSessions] register success') && hooks.includes('[DeviceSessions] heartbeat ok'), '§40: registration/heartbeat observability');
  ok(!hooks.match(/console\.\w+\([^)]*access_token/), '§32: no token logging in hooks');

  // Single admin client per request (RC-11).
  ok((hooks.match(/createClient<Database>/g) ?? []).length === 1, '§38: exactly one admin client creation per request');
}

// ============================================================
// REVOCATION LOOKUP (fail-open + cache semantics, §23)
// ============================================================
{
  console.log('Revocation lookup (§23)');

  // Active row → not revoked.
  {
    const admin = createAdmin([makeRow({ supabase_session_id: S1 })]);
    const { revoked } = await lookupSessionRevocationState(admin, U1, S1);
    ok(revoked === false, '§23a: active session is not revoked');
  }
  // Revoked row → revoked.
  {
    const admin = createAdmin([makeRow({ supabase_session_id: S1, revoked_at: new Date().toISOString() })]);
    const { revoked } = await lookupSessionRevocationState(admin, U1, S1);
    ok(revoked === true, '§23b: revoked session detected');
  }
  // Missing row → fail-open (not revoked).
  {
    const admin = createAdmin([]);
    const { revoked } = await lookupSessionRevocationState(admin, U1, S1);
    ok(revoked === false, '§23c: missing row fails open (fresh session race)');
  }

  const cache = read('src/lib/server/auth/session-revocation-cache.ts');
  ok(cache.includes('MAX_CACHED_SESSIONS'), '§23d: cache is bounded');
  ok(cache.includes('REVOCATION_CACHE_TTL_MS = 30'), '§23e: 30s TTL preserved');
  ok(cache.includes('cache.delete(supabaseSessionId)'), '§23f: invalidate removes the entry');
}

// ============================================================
// DEVICE-CLASS HELPERS (§7 — server/client consistent capability logic)
// ============================================================
{
  console.log('Device classes (§7)');

  ok(isBigScreen('desktop') === true && isBigScreen('tv') === true, '§7a: desktop/tv are BIG_SCREEN');
  ok(isBigScreen('mobile') === false && isBigScreen('tablet') === false, '§7b: mobile/tablet are not big screens');
  ok(isBigScreen('unknown') === false && isBigScreen(null) === false, '§7c: unknown is not a big screen');
  ok(isQrScannerDevice('mobile') === true && isQrScannerDevice('tablet') === true, '§7d: mobile/tablet are QR_SCANNER');
  ok(isQrScannerDevice('desktop') === false && isQrScannerDevice('tv') === false, '§7e: desktop/tv are not scanners');
  ok(deviceTypeLabel('mobile') === 'Phone' && deviceTypeLabel('tablet') === 'Tablet' && deviceTypeLabel('desktop') === 'Desktop' && deviceTypeLabel('tv') === 'TV' && deviceTypeLabel('unknown') === 'Device', '§7f: device-class labels');
}

// ============================================================
// JWT SESSION ID (§4 — session identity)
// ============================================================
{
  console.log('Session identity (§4)');

  // Build a realistic unsigned JWT payload (the extractor reads the
  // already-server-verified token's payload — no signature needed).
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const token = `header.${b64({ sub: U1, session_id: S1, exp: 9999999999 })}.signature`;
  ok(extractSessionId(token) === S1, '§4a: session_id extracted from the JWT payload');
  ok(extractSessionId('not-a-jwt') === null, '§4b: malformed token → null');
  ok(extractSessionId(`x.${b64({ sub: U1 })}.y`) === null, '§4c: missing session_id claim → null');
  ok(extractSessionId(null) === null && extractSessionId(undefined) === null, '§4d: null/undefined → null');
}

// ============================================================
// RPC SQL CONTRACT — pin every fake-implemented branch to the real SQL
// ============================================================
{
  console.log('RPC SQL contract (20260930000000)');

  const rpc = read('supabase/migrations/20260930000000_register_device_session_rpc.sql');
  ok(rpc.includes('for update'), 'SQL: row lock (SELECT ... FOR UPDATE)');
  ok(rpc.includes('p_heartbeat_interval_ms'), 'SQL: heartbeat interval parameter');
  ok(/registered boolean/.test(rpc), 'SQL: registered flag in the return type');
  ok(/unique_violation\s+then/.test(rpc), 'SQL: concurrent-INSERT race handled');
  const migration = read('supabase/migrations/20260927000000_device_sessions.sql');
  ok(migration.includes('UNIQUE INDEX') && migration.includes('(user_id, supabase_session_id)'), 'SQL: unique index on (user_id, supabase_session_id) — §31');
}

console.log(`\nDevice session registry v2 tests passed (${passed} checks).`);
