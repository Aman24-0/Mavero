/**
 * Task 4 regression (2026-10-15) — device-session forensics + honest
 * metadata for the "Unknown device" population.
 *
 * Reported production evidence: 45 device_sessions rows, 2 users, 28
 * "Unknown device" rows — all active, all created within 48h, all with
 * last_seen_at = created_at, all with DISTINCT Supabase session ids.
 *
 * This suite pins the CODE-LEVEL facts the forensic audit established
 * (the live-DB origin attribution stays owner-side via
 * scripts/mav_task4_session_forensics_probe.mjs — no valid credentials
 * exist in the audit environment):
 *
 *   §A  extractSessionId reads the STABLE Supabase session_id claim —
 *       never jti/token-hash/refresh-derived values (distinct rows can
 *       only mean distinct genuine Supabase sessions).
 *   §B  HONEST metadata: a missing UA and an unrecognized UA produce
 *       DISTINCT, descriptive labels (both still deviceType 'unknown' —
 *       no privileges, no identity).
 *   §C  Registration is authentication-gated + revocation-gated
 *       (hooks.server.ts contract — a request that is not fully
 *       authenticated can never create a registry row; a revoked
 *       session is never resurrected).
 *   §D  Registry identity + idempotency invariants (RPC source):
 *       (user_id, supabase_session_id) keying, heartbeat throttle,
 *       SELECT ... FOR UPDATE, no-resurrect, unique-violation fallback.
 *   §E  List projection safety: /api/account/sessions never exposes
 *       user_id, raw supabase_session_id, device_id, ip_hash, tokens
 *       or IPs; isCurrent is computed server-side.
 *   §F  listUserSessions filtering contract (revoked + >30d stale
 *       excluded; rows never deleted).
 *   §G  Device-id cookie hygiene (httpOnly, sameSite lax, secure on
 *       HTTPS, no session material).
 *   §H  No destructive path was added: revoke/cleanup code is unchanged
 *       (no auto-revocation of the unknown population).
 *
 * Run: pnpm exec tsx --tsconfig ./jsconfig.json scripts/mav_task4_device_session_forensics_test.ts
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p: string) => readFileSync(resolve(root, p), 'utf-8');

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ok ${passed} - ${label}`); }
  else { failed += 1; console.log(`  FAIL - ${label}`); }
}

async function run() {
  console.log('\nTask 4 — device-session forensics\n');

  // §A — stable session identity
  console.log('§A — stable session identity');
  {
    const { extractSessionId } = await import('../src/lib/server/auth/jwt-session-id');
    const token = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ session_id: '11111111-2222-3333-4444-555555555555' })).toString('base64url'), 'sig'].join('.');
    ok(extractSessionId(token) === '11111111-2222-3333-4444-555555555555', 'A1. extracts the session_id claim');
    const noClaim = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ jti: 'per-refresh-value' })).toString('base64url'), 'sig'].join('.');
    ok(extractSessionId(noClaim) === null, 'A2. missing claim → null (no jti/token-hash fallback — distinct rows always mean distinct Supabase sessions)');
    ok(extractSessionId('garbage') === null, 'A3. malformed token → null');
  }

  // §B — honest metadata
  console.log('\n§B — honest device metadata');
  {
    const { parseDeviceMetadata } = await import('../src/lib/server/auth/device-metadata');
    const missing = parseDeviceMetadata(null);
    ok(missing.deviceType === 'unknown', 'B1. missing UA → deviceType unknown (no privileges, no identity)');
    ok(missing.deviceName === 'Unidentified client (no User-Agent)', 'B2. missing UA → explicit "no User-Agent" label (security-relevant signal is visible)');
    const unrecognized = parseDeviceMetadata('SomeObscureBot/1.2 (scanner)');
    ok(unrecognized.deviceName === 'Unrecognized client', 'B3. non-matching UA → "Unrecognized client" (distinct from missing-UA)');
    const chrome = parseDeviceMetadata('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
    ok(chrome.deviceName === 'Windows • Chrome' && chrome.deviceType === 'desktop', 'B4. normal browsers keep their descriptive metadata');
  }

  // §C — registration gates (hooks contract)
  console.log('\n§C — registration gates (hooks.server.ts)');
  {
    const hooks = src('src/hooks.server.ts');
    ok(/if \(!sessionRevoked && auth\.session && auth\.user && admin && supabaseSessionId\)/.test(hooks), 'C1. registration runs ONLY for fully-authenticated, non-revoked requests');
    ok(/const \{ revoked \} = await isSessionRevoked\(/.test(hooks), 'C2. revocation check runs BEFORE registration');
    ok(/sessionRevoked = true;[\s\S]{0,400}Do NOT fall through to registration/.test(hooks) || /event\.locals\.session = null;\s*\n\s*event\.locals\.user = null;\s*\n\s*sessionRevoked = true;/.test(hooks), 'C3. revoked sessions are rejected and NOT re-registered');
    ok(/extractSessionId\(auth\.session\.access_token\)/.test(hooks), 'C4. the registry key comes from the JWT session_id claim (server-derived)');
    ok(/PRIVATE_SUPABASE_SERVICE_ROLE_KEY/.test(hooks) && !/access_token[^'"]*['"]\s*\+\s*['"]\s*\+/.test(hooks), 'C5. service-role path only; no token material logged');
  }

  // §D — RPC invariants (migration source)
  console.log('\n§D — register_device_session RPC invariants');
  {
    const rpc = src('supabase/migrations/20260930000000_register_device_session_rpc.sql');
    ok(/where user_id = p_user_id\s*\n?\s*and supabase_session_id = p_supabase_session_id\s*\n?\s*for update/.test(rpc), 'D1. SELECT ... FOR UPDATE on the (user_id, supabase_session_id) identity');
    ok(/v_row\.revoked_at is not null then[\s\S]{0,500}return;/.test(rpc), 'D2. revoked rows are NEVER resurrected (empty return)');
    ok(/extract\(epoch from \(p_now - v_row\.last_seen_at\)\) \* 1000 < p_heartbeat_interval_ms/.test(rpc), 'D3. heartbeat throttle honored (no write inside the interval)');
    ok(/exception\s*\n?\s*when unique_violation then/.test(rpc), 'D4. concurrent first-registrations converge (unique-violation fallback selects the winner)');
    ok(/security definer/.test(rpc) && /to service_role/.test(rpc) && /from anon/.test(rpc) && /from authenticated/.test(rpc), 'D5. privilege model: SECURITY DEFINER, EXECUTE only for service_role');
    const base = src('supabase/migrations/20260927000000_device_sessions.sql');
    ok(/ON public\.device_sessions \(user_id, supabase_session_id\)/.test(base), 'D6. unique index on (user_id, supabase_session_id) — one row per genuine Supabase session');
    ok(/USING \(auth\.uid\(\) = user_id\)/.test(base), 'D7. RLS: clients can only read their own rows');
  }

  // §E — list projection safety
  console.log('\n§E — session list projection safety');
  {
    const endpoint = src('src/routes/api/account/sessions/+server.ts');
    // The projected object body is the authoritative surface — comments may
    // legitimately NAME the forbidden fields ("never expose …").
    const projectedBody = endpoint.slice(endpoint.indexOf('const projected = sessions.map'), endpoint.indexOf('return json({ ok: true, sessions: projected }'));
    for (const forbidden of ['supabase_session_id: row.supabase_session_id', 'device_id: row.device_id', 'ip_hash', 'user_id: row.user_id']) {
      ok(!projectedBody.includes(forbidden), `E1. projection never exposes ${forbidden.split(':')[0].trim()}`);
    }
    ok(/isCurrent: row\.supabase_session_id === currentSessionId/.test(endpoint), 'E2. isCurrent computed SERVER-side from the JWT claim (raw id never returned)');
    ok(/listUserSessions\(admin, user\.id\)/.test(endpoint), 'E3. user-scoped listing only');
    ok(/'cache-control': 'no-store'/.test(endpoint), 'E4. no-store on the session list');
  }

  // §F — list filtering contract
  console.log('\n§F — listUserSessions filtering');
  {
    const svc = src('src/lib/server/auth/device-sessions.ts');
    ok(/\.is\('revoked_at', null\)/.test(svc) && /\.gt\('last_seen_at', staleCutoff\)/.test(svc), 'F1. active list excludes revoked AND >30d-stale rows (rows are never deleted)');
    ok(/STALE_SESSION_RETENTION_MS = 30 \* 24 \* 60 \* 60 \* 1000/.test(svc), 'F2. stale threshold documented and stable (30d)');
  }

  // §G — cookie hygiene
  console.log('\n§G — device-id cookie hygiene');
  {
    const { ensureDeviceIdCookie } = await import('../src/lib/server/auth/device-metadata');
    let captured: { value: string; options: Record<string, unknown> } | null = null;
    const id = ensureDeviceIdCookie(null, (value, options) => { captured = { value, options: options as Record<string, unknown> }; }, true);
    ok(typeof id === 'string' && id.length >= 8, 'G1. device id generated');
    ok(captured !== null && captured!.options.httpOnly === true && captured!.options.sameSite === 'lax' && captured!.options.path === '/' && captured!.options.secure === true, 'G2. cookie flags: httpOnly + lax + path=/ + secure on HTTPS');
    const unchanged = ensureDeviceIdCookie('existing-device-id-value', () => { throw new Error('must not set'); }, true);
    ok(unchanged === 'existing-device-id-value', 'G3. existing cookie → zero cookie writes');
  }

  // §H — no destructive path added
  console.log('\n§H — no auto-revocation / no cleanup of the unknown population');
  {
    const svc = src('src/lib/server/auth/device-sessions.ts');
    ok(!/delete\(\)/.test(svc), 'H1. the registry service contains NO delete path (history preserved)');
    ok(/mark a session as revoked/.test(svc), 'H2. revocation remains the explicit sign-out action');
    const hooks = src('src/hooks.server.ts');
    ok(!/delete\(\)/.test(hooks), 'H3. the hook never deletes session rows');
  }

  console.log(`\nTask 4 result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
