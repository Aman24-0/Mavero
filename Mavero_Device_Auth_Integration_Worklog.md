# MAVERO Device Auth Integration Worklog

## Phase 1: Session Registry + Device Identity Foundation

### Starting commit
`2200042757ad39f0ce38646f11694d8777795602`

### Audit findings

1. **Server hook** (`src/hooks.server.ts`): resolves auth ONCE per request via `locals.safeGetSession()`. Stores `locals.session` and `locals.user`. Session is a Supabase `Session` object with `access_token`, `refresh_token`, `expires_at`, and a `user` object. The `session.user.id` is the Supabase user UUID. The session itself has NO stable "session ID" field — Supabase sessions are identified by their `access_token` (JWT). The JWT's `session_id` claim (extractable from the decoded JWT payload `session.user.id` is the user UUID, but the actual session-level identifier within Supabase is the `session_id` claim inside the JWT payload — NOT exposed as a top-level field on the Session object.

2. **Key decision: session identity.** The Supabase `Session` object does NOT expose a stable `session_id` as a top-level field. However, the `access_token` JWT contains a `session_id` claim (UUID) that uniquely identifies the Supabase auth session. This is the canonical session identity. We decode it from the JWT (no network call needed — the JWT is already on `locals.session.access_token`).

3. **Root layout** (`src/routes/+layout.server.ts`): reads `locals.user` directly (no re-auth). Projects minimal `{ id, email, displayName }` to the client. No tokens reach the client.

4. **Sign-in** (`src/routes/auth/sign-in/+page.server.ts`): calls `locals.supabase.auth.signInWithPassword()`, then redirects. Registration should happen on the NEXT authenticated request (not inside the sign-in action — the session isn't fully established until the redirect lands).

5. **Sign-out** (`src/routes/auth/sign-out/+server.ts`): calls `locals.supabase.auth.signOut()`, redirects to `/discover`. Should also mark the device_sessions row as revoked.

6. **Account deletion** (`src/routes/api/account/delete/+server.ts`): calls `deleteAuthenticatedAccount()` which deletes the Supabase auth user. The `ON DELETE CASCADE` FK on `device_sessions.user_id → auth.users(id)` ensures cleanup.

7. **Admin client** (`src/lib/server/supabase/admin.ts`): creates a service-role Supabase client for server-side privileged operations.

8. **Database types** (`src/lib/server/supabase/database.types.ts`): manually maintained. Must add `device_sessions` table types.

### Architecture decisions

- **Session identity**: use the `session_id` claim from the decoded JWT access token. This is the Supabase canonical session identifier. We decode it server-side without any network call.
- **Device ID**: use a random UUID generated on first visit (stored in a cookie). This is NOT an authentication credential — it's a soft grouping identifier that helps recognize the same browser across different sessions. It's privacy-conscious: not derived from PII, not a fingerprint, not used for access control.
- **Registration point**: in `hooks.server.ts`, after `locals.session` and `locals.user` are resolved. If authenticated, register/touch the device session. This ensures every authenticated request (not just login) registers the session.
- **Heartbeat throttle**: 5 minutes. Only update `last_seen_at` if the stored value is older than 5 minutes. This limits DB writes to at most 1 per 5 minutes per active session.
- **Sign-out**: mark the device_sessions row as `revoked_at = now()` when the user signs out.
- **RLS**: read-only for authenticated users (can only see their own sessions). All writes are server-side via the admin client. No client-side INSERT/UPDATE/DELETE.
- **IP hashing**: omitted in Phase 1. Not needed for session registry. Can be added in a future security/audit phase.

### Files to create
- `supabase/migrations/20260927000000_device_sessions.sql`
- `src/lib/server/auth/device-metadata.ts`
- `src/lib/server/auth/device-sessions.ts`
- `src/lib/server/auth/jwt-session-id.ts`
- `scripts/device_session_registry_test.ts`

### Files to modify
- `src/hooks.server.ts` (add session registration call)
- `src/routes/auth/sign-out/+server.ts` (add revocation call)
- `src/lib/server/supabase/database.types.ts` (add device_sessions types)
- `package.json` (add test script)
