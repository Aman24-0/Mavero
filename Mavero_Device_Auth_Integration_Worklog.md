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

---

## Phase 3.2: QR Exchange Atomicity + Credential Boundary Hardening

### Starting commit
`bf6b16e892f9ab1fc738fb7f212ecb77fa6f56c8` (Phase 3.1 hardening)

### Audit findings (re-audit at the starting commit, not trusting prior Phase 3.1 report)

1. **Exchange endpoint** (`src/routes/api/auth/device-pairing/exchange/+server.ts`)
   performs a non-atomic SELECT → check → exchangeCodeForSession flow.
   Two concurrent requests can both pass the SELECT (both see
   `status='approved'` and `consumed_at IS NULL`) and both invoke
   `exchangeCodeForSession(code)`. Supabase's OTP layer will probably
   reject the second call, but the *pairing state* itself does NOT
   enforce single-use.

2. **Consumption is client-dependent.** After a successful exchange,
   the TV must separately POST `/api/auth/device-pairing/consume` to
   clear the exchange_code and mark the pairing as `consumed`. If the
   client never calls `/consume` (network drop, tab closed, browser
   crash), the pairing stays in `approved` state with `exchange_code`
   still readable on the next SELECT — leaving a replay window until
   the 5-minute TTL expires.

3. **Generic status service selects exchange_code unnecessarily.**
   `getPairingBySecret()` selects `exchange_code` from the DB and
   returns it on the `PairingStatusResponse` (as `exchangeCode`).
   The status endpoint currently does NOT echo it back to the client
   (Phase 3.1 comment only), but the *service contract* still
   carries the credential through every status lookup. This is an
   unnecessary credential-boundary leak.

4. **`/api/auth/device-pairing/info`** correctly selects only
   metadata (no exchange_code) — preserved as-is.

5. **`/api/auth/device-pairing/cancel`** correctly uses atomic
   `pending → cancelled` transition guarded by `.eq('status', 'pending')`
   — preserved.

6. **QR generation** uses local `qrcode` package — no external
   `api.qrserver.com` reference anywhere in the repo (grep-confirmed)
   — preserved.

7. **Approve endpoint** correctly uses atomic `pending → approved`
   transition guarded by `.eq('status', 'pending')`. The `generateLink()`
   call happens BEFORE the atomic UPDATE — if two approvals race, both
   call `generateLink()` (consuming Supabase quota), but only one UPDATE
   succeeds. This is a minor quota concern, NOT a security issue.
   Preserved as-is — out of scope for Phase 3.2.

### Exact race/replay issue found

Two concurrent POSTs to `/api/auth/device-pairing/exchange` with the
same `secret` can both pass the SELECT and both invoke
`exchangeCodeForSession(code)`. Even if Supabase rejects the second
OTP redemption, the pairing itself remains in `approved` state until
the TV client calls `/consume` — and if the client never does, the
pairing is stuck in `approved` until TTL expiry, leaving the
exchange_code readable on subsequent SELECTs.

### Chosen concurrency design

**Single atomic UPDATE…RETURNING claim.**

```sql
UPDATE device_pairing_requests
SET status = 'consumed',
    consumed_at = now(),
    exchange_code = NULL        -- clear in same statement
WHERE secret_hash = $1
  AND status = 'approved'
  AND consumed_at IS NULL
  AND expires_at > now()
RETURNING id, exchange_code;    -- code returned ONLY to the claimer
```

Properties:
- Postgres serializes concurrent UPDATEs on the same row via
  row-level lock — exactly one request receives a non-empty
  RETURNING result.
- `exchange_code` is cleared from disk in the SAME statement that
  claims the row — no other request can SELECT it afterwards.
- The returned `exchange_code` lives in server memory only for the
  duration of `exchangeCodeForSession()` and is never serialized
  to JSON, never logged, never returned to the client.
- The claim IS the consume — no separate `/consume` endpoint needed.
- Failure of `exchangeCodeForSession()` is terminal: the pairing is
  already in `consumed` state, the OTP has been consumed (or is
  unusable), and the user must re-pair. This is acceptable because
  the OTP cannot be retried without re-running `generateLink()` (which
  requires the phone user's auth context the TV doesn't have).

**No schema migration required** — `consumed` is already in the
status CHECK constraint, `consumed_at` column already exists, all
state transitions are guarded by WHERE clauses.

### Exchange credential boundary

| Path            | Reads exchange_code? | Returns exchange_code? |
|-----------------|---------------------:|----------------------:|
| /status         | NO                   | NO                    |
| /info           | NO                   | NO                    |
| /approve        | NO (writes only)     | NO                    |
| /cancel         | NO                   | NO                    |
| /exchange       | YES (internal only)  | NO                    |
| /consume        | REMOVED              | n/a                   |

### Status API contract

```json
{ "ok": true, "status": "pending|approved|consumed|expired|cancelled" }
```

`cache-control: no-store` on all pairing responses. No `exchangeCode`
field, no `exchange_code`, no `access_token`, no `refresh_token`,
no session object.

### Consume endpoint outcome

`POST /api/auth/device-pairing/consume` removed entirely.
`consumePairingRequest()` service function removed.
TV `/tv-login/+page.svelte` no longer calls `/consume` after
exchange — the exchange endpoint finalizes server-side.

### Cancellation behavior

Preserved: `pending → cancelled` atomic transition (guarded by
`.eq('status', 'pending')`). A cancelled request CANNOT be:
- approved (approve checks `.eq('status', 'pending')`)
- exchanged (exchange checks `.eq('status', 'approved')`)
- consumed (no /consume endpoint)

### QR generation security

Local `qrcode` package via `QRCode.toDataURL()`. Grep-confirmed:
zero references to `api.qrserver.com`, `qrserver.com`, or any
external QR image service in the repository.

### Files changed
- `src/lib/server/auth/device-pairing.ts` — refactor: drop
  `exchangeCode` from `PairingStatusResponse`; drop
  `consumePairingRequest()`; `getPairingBySecret()` selects only
  `status` + `expires_at`; new `claimAndExchangePairing()` function
  performs the atomic claim.
- `src/routes/api/auth/device-pairing/exchange/+server.ts` —
  rewritten to call `claimAndExchangePairing()`; removes the
  non-atomic SELECT path; never returns or logs exchange_code.
- `src/routes/api/auth/device-pairing/status/+server.ts` —
  simplified status response; no `exchangeCode` field.
- `src/routes/api/auth/device-pairing/consume/+server.ts` — DELETED.
- `src/routes/tv-login/+page.svelte` — removes the
  `fetch('/api/auth/device-pairing/consume', ...)` call after exchange.
- `scripts/device_pairing_test.ts` — adds tests A–P from the Phase 3.2
  spec; updates existing tests for the new contract.

### Schema/migration changes
NONE. The existing schema (status CHECK constraint, `consumed_at`,
`exchange_code` nullable columns) is sufficient for the atomic claim
design.

### Validation results
- `pnpm check` (svelte-kit sync + svelte-check) — passes
  (`svelte-check found 0 errors and 0 warnings`)
- `pnpm test` — 136 of 144 test suites pass. The 8 failing suites
  (`phase5_cloud_test`, `phase6_auth_test`, `phase6_rls_test`,
  `phase7a_public_config_test`, `phase7a_security_test`,
  `phase7a_validation_test`, `player_fab_autohide_test`,
  `search_performance_test`) are PRE-EXISTING failures unrelated to
  Phase 3.2 — they require live Supabase credentials or test Phase
  5/6/7 features outside the device-pairing surface area. Grep
  confirms none of them reference `device-pairing` or
  `device_pairing`. Verified by stashing Phase 3.2 changes and
  re-running the same tests on the starting commit `bf6b16e` —
  identical failures.
- `pnpm build` (vite build) — passes (`✓ built in 26.03s`)
- `scripts/device_pairing_test.ts` — all 294 check groups pass
  (was 21 check groups in Phase 3.1, now expanded with Phase 3.2
  invariants A–P).

### Runtime/browser verification status
NOT performed — no live Supabase credentials in this environment.
Tests are static contract + deterministic unit tests only.
Behavior verified by:
- Source-text contract assertions (no `exchangeCode` in status path,
  no `exchange_code` in client code, no external QR service)
- Logic-reasoned concurrency analysis (Postgres row-level locking
  guarantees single-winner UPDATE…RETURNING)
- Type checking (TypeScript enforces no `exchangeCode` field on the
  response shape)

### Limitations
- No live integration test against a real Supabase instance with
  concurrent exchange requests. The atomic claim relies on
  Postgres's documented row-locking semantics for UPDATE…RETURNING;
  this is the standard pattern and is correct under MVCC, but a
  full integration test would require real credentials.
- Approve endpoint still calls `generateLink()` before the atomic
  UPDATE — concurrent approvals can burn Supabase quota. Documented
  as out-of-scope for Phase 3.2 (not a security issue).

### Final commit
`4db4c116f9221b4774e5979fbf0bc49b9df2a99c`

(Note: an earlier commit `33f1b07` was superseded by `4db4c11` after
amending to include the worklog-finalization diff in the same
single commit. Force-pushed to update the remote.)

Commit message:
```
fix(auth): make QR exchange single-use and isolate credential handling
```

Files changed (7):
- `Mavero_Device_Auth_Integration_Worklog.md` (this file)
- `scripts/device_pairing_test.ts` (expanded from 21 → 294 check groups, invariants A–P)
- `src/lib/server/auth/device-pairing.ts` (refactored: removed `consumePairingRequest`, removed `exchangeCode` from `PairingStatusResponse`, `getPairingBySecret` selects only `status, expires_at`; new `claimAndExchangePairing` performs the atomic claim+exchange)
- `src/routes/api/auth/device-pairing/consume/+server.ts` (DELETED — exchange finalizes atomically)
- `src/routes/api/auth/device-pairing/exchange/+server.ts` (rewritten: delegates to `claimAndExchangePairing`, no separate SELECT, no credential returned/logged)
- `src/routes/api/auth/device-pairing/status/+server.ts` (simplified: `{ ok, status }` only)
- `src/routes/tv-login/+page.svelte` (removed `/consume` call after exchange)

### Push confirmation
Pushed to `origin/main` successfully (force-pushed after amend to
keep the single-commit requirement).
Local `main` → `4db4c11`.
Remote `refs/heads/main` → `4db4c116f9221b4774e5979fbf0bc49b9df2a99c`.
Working tree clean. No uncommitted files remain.

```
$ git push --force-with-lease origin main
To https://github.com/Aman24-0/Mavero.git
 + 33f1b07...4db4c11 main -> main (forced update)
```
