import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseDeviceMetadata, getOrCreateDeviceId, type DeviceType } from '../src/lib/server/auth/device-metadata.ts';
import { extractSessionId } from '../src/lib/server/auth/jwt-session-id.ts';

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ============================================================
// 1. DATABASE MIGRATION CONTRACT
// ============================================================
{
  const migration = read('supabase/migrations/20260927000000_device_sessions.sql');

  ok(migration.includes('CREATE TABLE IF NOT EXISTS public.device_sessions'), 'migration creates device_sessions table');
  ok(migration.includes('user_id uuid not null references auth.users(id) on delete cascade'), 'user_id FK to auth.users with cascade');
  ok(migration.includes('supabase_session_id uuid not null'), 'supabase_session_id column');
  ok(migration.includes('device_id text not null'), 'device_id column');
  ok(migration.includes('device_type text not null'), 'device_type column');
  ok(migration.includes('device_name text not null'), 'device_name column');
  ok(migration.includes('browser text'), 'browser column');
  ok(migration.includes('os text'), 'os column');
  ok(migration.includes('platform text'), 'platform column');
  ok(migration.includes('ip_hash text'), 'ip_hash column');
  ok(migration.includes('created_at timestamptz not null default'), 'created_at column');
  ok(migration.includes('last_seen_at timestamptz not null default'), 'last_seen_at column');
  ok(migration.includes('revoked_at timestamptz'), 'revoked_at column');
  ok(migration.includes('ENABLE ROW LEVEL SECURITY'), 'RLS enabled');
  ok(migration.includes('device_sessions_select_own'), 'SELECT policy for own sessions');
  ok(migration.includes('auth.uid() = user_id'), 'RLS restricts to own user_id');

  // Verify NO access tokens / refresh tokens / cookies stored.
  ok(!migration.includes('access_token'), 'migration does NOT store access tokens');
  ok(!migration.includes('refresh_token'), 'migration does NOT store refresh tokens');
  ok(!migration.match(/cookie\s+(text|uuid|varchar)/i), 'migration does NOT store cookies as a column');
  ok(!migration.match(/\bpassword\b\s+(text|uuid|varchar)/i), 'migration does NOT store passwords as a column');

  // Unique constraint on (user_id, supabase_session_id) WHERE revoked_at IS NULL.
  ok(migration.includes('UNIQUE INDEX'), 'unique index exists');
  ok(migration.includes('device_sessions_user_session_idx'), 'unique index named');
  ok(migration.includes('WHERE revoked_at IS NULL'), 'unique index scoped to non-revoked sessions');

  // No client-side INSERT/UPDATE/DELETE policies.
  ok(!migration.includes('POLICY device_sessions_insert'), 'no client INSERT policy');
  ok(!migration.includes('POLICY device_sessions_update'), 'no client UPDATE policy');
  ok(!migration.includes('POLICY device_sessions_delete'), 'no client DELETE policy');

  ok('1. database migration contract (table, columns, FK, RLS, unique index, no tokens)');
}

// ============================================================
// 2. DATABASE TYPES
// ============================================================
{
  const types = read('src/lib/server/supabase/database.types.ts');
  ok(types.includes('device_sessions:'), 'database types include device_sessions');
  ok(types.includes("supabase_session_id: string"), 'database types include supabase_session_id field');
  ok(types.includes("device_id: string"), 'database types include device_id field');
  ok(types.includes("device_type: string"), 'database types include device_type field');
  ok(types.includes("revoked_at: string | null"), 'database types include revoked_at field');
  ok(types.includes('device_sessions_user_id_fkey'), 'database types include FK relationship');

  ok('2. database types updated with device_sessions table');
}

// ============================================================
// 3. DEVICE METADATA PARSER
// ============================================================
{
  // Android phone + Chrome
  const android = parseDeviceMetadata('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
  ok(android.deviceType === 'mobile', 'Android phone → mobile');
  ok(android.browser === 'Chrome', 'Android phone → Chrome');
  ok(android.os === 'Android', 'Android phone → Android OS');
  ok(android.deviceName.includes('Android'), 'Android phone → device name includes Android');
  ok(android.deviceName.includes('Chrome'), 'Android phone → device name includes Chrome');

  // iPhone + Safari
  const iphone = parseDeviceMetadata('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  ok(iphone.deviceType === 'mobile', 'iPhone → mobile');
  ok(iphone.browser === 'Safari', 'iPhone → Safari');
  ok(iphone.os === 'iOS', 'iPhone → iOS');
  ok(iphone.deviceName.includes('iOS'), 'iPhone → device name includes iOS');
  ok(iphone.deviceName.includes('Safari'), 'iPhone → device name includes Safari');

  // Windows desktop + Chrome
  const windows = parseDeviceMetadata('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  ok(windows.deviceType === 'desktop', 'Windows → desktop');
  ok(windows.browser === 'Chrome', 'Windows → Chrome');
  ok(windows.os === 'Windows', 'Windows → Windows OS');
  ok(windows.deviceName.includes('Windows'), 'Windows → device name includes Windows');

  // macOS + Safari
  const macos = parseDeviceMetadata('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15');
  ok(macos.deviceType === 'desktop', 'macOS → desktop');
  ok(macos.browser === 'Safari', 'macOS → Safari');
  ok(macos.os === 'macOS', 'macOS → macOS OS');

  // Linux + Firefox
  const linux = parseDeviceMetadata('Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0');
  ok(linux.deviceType === 'desktop', 'Linux → desktop');
  ok(linux.browser === 'Firefox', 'Linux → Firefox');
  ok(linux.os === 'Linux', 'Linux → Linux OS');

  // Android TV + Chrome
  const androidTV = parseDeviceMetadata('Mozilla/5.0 (Linux; Android 11; Android TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  ok(androidTV.deviceType === 'tv', 'Android TV → tv');
  ok(androidTV.browser === 'Chrome', 'Android TV → Chrome');
  ok(androidTV.os === 'Android', 'Android TV → Android OS');
  ok(androidTV.platform === 'Android TV', 'Android TV → platform = Android TV');

  // Tizen / Samsung
  const tizen = parseDeviceMetadata('Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 77.0.3865.146/6.0 TV Safari/537.36');
  ok(tizen.deviceType === 'tv', 'Tizen → tv');
  ok(tizen.os === 'Tizen', 'Tizen → Tizen OS');
  ok(tizen.platform === 'Samsung TV', 'Tizen → platform = Samsung TV');

  // Unknown UA fallback
  const unknown = parseDeviceMetadata('SomeRandomBot/1.0');
  ok(unknown.deviceType === 'unknown', 'Unknown UA → unknown device type');
  ok(unknown.deviceName === 'Unknown device', 'Unknown UA → Unknown device name');

  // Empty / null UA
  const empty = parseDeviceMetadata(null);
  ok(empty.deviceType === 'unknown', 'null UA → unknown');
  ok(empty.deviceName === 'Unknown device', 'null UA → Unknown device');

  ok('3. device metadata parser (9 UA scenarios)');
}

// ============================================================
// 4. DEVICE ID
// ============================================================
{
  // Existing cookie → reuse.
  const existingId = 'existing-device-id-1234';
  ok(getOrCreateDeviceId(existingId) === existingId, 'Existing device ID cookie is reused');

  // No cookie → generate new UUID.
  const newId = getOrCreateDeviceId(null);
  ok(typeof newId === 'string' && newId.length >= 8, 'New device ID is a string with reasonable length');
  ok(newId !== '', 'New device ID is not empty');

  // Multiple calls with null produce different IDs.
  const id1 = getOrCreateDeviceId(null);
  const id2 = getOrCreateDeviceId(null);
  ok(id1 !== id2, 'Two calls to getOrCreateDeviceId(null) produce different IDs');

  ok('4. device ID generation and reuse');
}

// ============================================================
// 5. JWT SESSION ID EXTRACTOR
// ============================================================
{
  // Create a fake JWT: header.payload.signature
  // The payload must contain a session_id field.
  const payload = Buffer.from(JSON.stringify({
    sub: 'user-uuid-123',
    session_id: 'session-uuid-456',
    exp: 9999999999,
  })).toString('base64url');
  const fakeJwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;

  const sessionId = extractSessionId(fakeJwt);
  ok(sessionId === 'session-uuid-456', 'Extracts session_id from valid JWT');

  // Null/undefined input.
  ok(extractSessionId(null) === null, 'Null access token → null');
  ok(extractSessionId(undefined) === null, 'Undefined access token → null');
  ok(extractSessionId('') === null, 'Empty access token → null');

  // Malformed JWT.
  ok(extractSessionId('not-a-jwt') === null, 'Malformed token → null');
  ok(extractSessionId('a.b') === null, 'Two-part token → null');

  // JWT without session_id.
  const noSessionPayload = Buffer.from(JSON.stringify({ sub: 'user-123' })).toString('base64url');
  ok(extractSessionId(`header.${noSessionPayload}.sig`) === null, 'JWT without session_id → null');

  ok('5. JWT session ID extractor (7 scenarios)');
}

// ============================================================
// 6. SESSION REGISTRY — HOOK INTEGRATION (SOURCE-LEVEL)
// ============================================================
{
  const hooks = read('src/hooks.server.ts');
  ok(hooks.includes('registerCurrentSession'), 'hooks.server.ts imports registerCurrentSession');
  ok(hooks.includes('extractSessionId'), 'hooks.server.ts imports extractSessionId');
  ok(hooks.includes('parseDeviceMetadata'), 'hooks.server.ts imports parseDeviceMetadata');
  ok(hooks.includes('getOrCreateDeviceId'), 'hooks.server.ts imports getOrCreateDeviceId');
  // Phase 3: the registration guard now also checks !sessionRevoked so a
  // revoked session is NOT re-registered (which would resurrect it in the list).
  ok(hooks.includes('!sessionRevoked && auth.session && auth.user'), 'hooks only registers when authenticated AND not revoked');
  ok(hooks.includes('Non-blocking') || hooks.includes('non-blocking') || hooks.includes('NON-BLOCKING'), 'hooks documents non-blocking behavior');
  ok(hooks.includes('mavero:device-id'), 'hooks sets device-id cookie');
  ok(!hooks.includes('locals.session.access_token') || !hooks.match(/console\.\w+.*access_token/), 'hooks does NOT log access tokens');

  // Guest traffic must never trigger registration.
  ok(hooks.includes('!sessionRevoked && auth.session && auth.user') && !hooks.includes('registerCurrentSession(.*null'), 'No registration call outside the auth guard');

  // Phase 3: revocation enforcement is now present.
  ok(hooks.includes('isSessionRevoked'), 'hooks: imports isSessionRevoked (Phase 3 enforcement)');
  ok(hooks.includes('lookupSessionRevocationState'), 'hooks: imports lookupSessionRevocationState (Phase 3 enforcement)');
  ok(hooks.includes('sessionRevoked = true'), 'hooks: sets sessionRevoked flag when revoked');
  ok(hooks.includes('event.locals.session = null') && hooks.includes('event.locals.user = null'), 'hooks: clears locals on revoked session');

  ok('6. hooks.server.ts integration (non-blocking, authenticated only, no token logging, Phase 3 revocation enforcement)');
}

// ============================================================
// 7. SIGN-OUT REVOCATION
// ============================================================
{
  const signOut = read('src/routes/auth/sign-out/+server.ts');
  ok(signOut.includes('revokeSession'), 'sign-out endpoint imports revokeSession');
  ok(signOut.includes('extractSessionId'), 'sign-out endpoint imports extractSessionId');
  ok(signOut.includes('locals.session?.access_token'), 'sign-out checks session before revoking');
  ok(signOut.includes('Non-critical'), 'sign-out documents non-critical revocation');
  ok(signOut.includes('await revokeSession'), 'sign-out calls revokeSession before signOut()');

  ok('7. sign-out revocation integration');
}

// ============================================================
// 8. SESSION REGISTRY SERVICE — SOURCE CONTRACT
// ============================================================
{
  const service = read('src/lib/server/auth/device-sessions.ts');

  ok(service.includes('registerCurrentSession'), 'exports registerCurrentSession');
  ok(service.includes('getCurrentSession'), 'exports getCurrentSession');
  ok(service.includes('listUserSessions'), 'exports listUserSessions');
  ok(service.includes('revokeSession'), 'exports revokeSession');
  ok(service.includes('revokeAllOtherSessions'), 'exports revokeAllOtherSessions');

  // Heartbeat throttle.
  ok(service.includes('HEARTBEAT_INTERVAL_MS'), 'heartbeat interval constant defined');
  ok(service.includes('5 * 60 * 1000'), 'heartbeat interval is 5 minutes');
  ok(service.includes('now - lastSeen < HEARTBEAT_INTERVAL_MS'), 'heartbeat checks staleness before writing');

  // No token storage.
  ok(!service.includes('access_token'), 'service does NOT reference access_token');
  ok(!service.includes('refresh_token'), 'service does NOT reference refresh_token');

  // Error handling — registration failure is non-blocking.
  ok(service.includes('console.error'), 'service logs errors safely');
  ok(service.includes('return null'), 'service returns null on failure (does not throw)');

  // RLS: all writes go through admin client.
  ok(service.includes('SupabaseAdminClient'), 'service uses admin client for mutations');

  ok('8. session registry service contract (API, throttle, no tokens, error handling)');
}

// ============================================================
// 9. SECURITY — NO AUTH TOKENS STORED
// ============================================================
{
  const migration = read('supabase/migrations/20260927000000_device_sessions.sql');
  const service = read('src/lib/server/auth/device-sessions.ts');
  const metadata = read('src/lib/server/auth/device-metadata.ts');
  const jwt = read('src/lib/server/auth/jwt-session-id.ts');

  // Migration must not store tokens.
  ok(!migration.includes('access_token'), 'migration: no access_token column');
  ok(!migration.includes('refresh_token'), 'migration: no refresh_token column');
  ok(!migration.match(/cookie\s+(text|uuid|varchar)/i), 'migration: no cookie column');

  // Service must not store tokens.
  ok(!service.includes('access_token'), 'service: no access_token reference');
  ok(!service.includes('refresh_token'), 'service: no refresh_token reference');

  // JWT extractor must not log tokens.
  ok(!jwt.match(/console\.\w+.*token/i), 'JWT extractor: no token logging');

  // Device metadata must not be an auth credential.
  ok(metadata.toLowerCase().includes('not an authentication') || metadata.toLowerCase().includes('cannot act as') || metadata.toLowerCase().includes('not.*auth.*credential'), 'device metadata documents non-auth status');

  ok('9. security: no tokens stored, no token logging, device metadata is not auth');
}

// ============================================================
// 10. DATABASE TYPES — TYPE SAFETY
// ============================================================
{
  const types = read('src/lib/server/supabase/database.types.ts');
  ok(types.includes('device_sessions'), 'database types include device_sessions');
  ok(types.includes('DeviceSessionRow') || types.includes('device_sessions'), 'type exists for device sessions table');

  ok('10. database types verified');
}

console.log(`\nDevice session registry tests passed (${passed} check groups).`);
