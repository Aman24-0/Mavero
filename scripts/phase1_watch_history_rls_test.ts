import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Phase 1 (audit BL-1 / DB-01) — watch_history upsert / RLS correctness.
 *
 * Problem: /api/account/history persists with
 *   .upsert(row, { onConflict: 'user_id,event_key' })
 * and 20260823081000_harden_history_idempotency.sql added the matching
 * unique index — so duplicate/retry events deterministically reach
 * INSERT ... ON CONFLICT DO UPDATE. watch_history had NO UPDATE policy,
 * so every duplicate/retry write failed with 42501 and the endpoint
 * returned 503 "History is temporarily unavailable".
 *
 * Fix: migration 20260921100000_phase1_watch_history_update_policy.sql adds
 * the narrowly scoped watch_history_update_own policy (initplan-safe
 * (select auth.uid()), USING + WITH CHECK strictly on the caller's own
 * rows — no cross-user updates).
 *
 * These tests are REAL behavioral tests where the repository's test
 * architecture allows them:
 *
 *   1. ENDPOINT BEHAVIOR — the route handler is imported and executed with
 *      a mock Supabase client that models the PostgREST conflict-update
 *      outcome. Proves the endpoint deliberately RELIES on the
 *      conflict-update semantics (the reason an UPDATE policy — not
 *      ignoreDuplicates — is the correct fix) and preserves its existing
 *      response conventions (ok / 503 on write error / 401 / 400).
 *   2. MIGRATION CONTRACT — the new migration is validated against the
 *      documented RLS conventions (initplan-safe expression, own-rows
 *      scoping on BOTH using and with check, authenticated-only role,
 *      idempotent drop-if-exists, and NO weakening of the existing
 *      policies). Migration SQL cannot be executed under tsx without a
 *      live database (the repository has no wired SQL integration tests —
 *      audit TEST-05), so the contract check is the honest regression
 *      guard for the policy shape.
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ============================================================
// 1. Endpoint behavior — duplicate/retry upsert succeeds
// ============================================================

type UpsertCall = { row: Record<string, unknown>; options: { onConflict?: string; ignoreDuplicates?: boolean } };

function createMockSupabase(errorResult: { message: string } | null, calls: UpsertCall[]) {
  return {
    from(table: string) {
      assert.equal(table, 'watch_history', 'history endpoint writes ONLY to watch_history');
      return {
        upsert(row: Record<string, unknown>, options: { onConflict?: string; ignoreDuplicates?: boolean }) {
          calls.push({ row, options });
          return Promise.resolve({ data: null, error: errorResult });
        },
        select() {
          return {
            order() {
              return {
                limit() {
                  return Promise.resolve({ data: [], error: null });
                },
              };
            },
          };
        },
      };
    },
  };
}

const { POST: historyPost } = await import('../src/routes/api/account/history/+server');

const historyEvent = {
  eventKey: 'movie-8633518:progress:0',
  eventType: 'progressed',
  contentType: 'movie',
  contentId: 'movie-8633518',
  currentTime: 42,
  duration: 6000,
  completionState: 'in_progress',
  snapshot: { title: 'Test Movie', poster: 'https://image.tmdb.org/test.jpg' },
  occurredAt: 1789000000000,
};

function historyRequest(event: unknown): Request {
  return new Request('https://mavero.test/api/account/history', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event }),
  });
}

const locals = (userId: string | null, errorResult: { message: string } | null = null, calls: UpsertCall[] = []) => ({
  supabase: createMockSupabase(errorResult, calls),
  safeGetSession: async () => (userId ? { session: {}, user: { id: userId } } : { session: null, user: null }),
});

const jsonBody = async (response: Response) => (await response.json()) as Record<string, unknown>;

// 1a. First write succeeds.
{
  const calls: UpsertCall[] = [];
  const response = await historyPost({ locals: locals('user-1', null, calls), request: historyRequest(historyEvent) } as never);
  assert.equal(response.status, 200, 'first history write returns 200');
  assert.equal((await jsonBody(response)).ok, true);
  ok(calls.length === 1, '1a. first history write performs exactly one upsert');
}

// 1b. DUPLICATE/RETRY write — the exact scenario BL-1 broke. The client
// models the RLS-allowed conflict-update (no error). It must succeed.
{
  const calls: UpsertCall[] = [];
  const retriedEvent = { ...historyEvent, currentTime: 90, occurredAt: 1789000060000 };
  const response = await historyPost({ locals: locals('user-1', null, calls), request: historyRequest(retriedEvent) } as never);
  assert.equal(response.status, 200, 'duplicate/retry history write returns 200 (conflict-update allowed by the new UPDATE policy)');
  assert.equal((await jsonBody(response)).ok, true, 'duplicate/retry write responds ok:true');
  const call = calls[0];
  ok(Boolean(call), '1b. duplicate/retry write issued the upsert');
  assert.equal(call.options.onConflict, 'user_id,event_key', 'conflict target is the (user_id, event_key) unique index');
  assert.notEqual(call.options.ignoreDuplicates, true, 'endpoint does NOT use ignoreDuplicates — refreshed payloads must WIN (latest-write-wins preserved)');
  assert.equal(call.row.user_id, 'user-1', 'upsert row is scoped to the authenticated user');
  assert.equal(call.row.position_seconds, 90, 'the refreshed position is the payload that must be persisted by the conflict-update');
}

// 1c. A denied conflict-update (simulating the OLD broken RLS state) maps to
// the existing 503 convention — the endpoint contract is unchanged.
{
  const calls: UpsertCall[] = [];
  const response = await historyPost({ locals: locals('user-1', { message: 'new row violates row-level security policy for table "watch_history"' }, calls), request: historyRequest(historyEvent) } as never);
  assert.equal(response.status, 503, 'upsert authorization failure maps to the existing 503 convention');
  assert.equal((await jsonBody(response)).message, 'History is temporarily unavailable.', 'error message convention preserved');
  ok(calls.length === 1, '1c. denied conflict-update surfaces the existing typed 503 envelope');
}

// 1d. Unauthenticated requests stay 401 (protection not weakened).
{
  const calls: UpsertCall[] = [];
  const response = await historyPost({ locals: locals(null, null, calls), request: historyRequest(historyEvent) } as never);
  assert.equal(response.status, 401, 'unauthenticated history write remains 401');
  ok(calls.length === 0, '1d. authentication requirement unchanged (no write issued)');
}

// 1e. Unauthorized user CANNOT update another user's history: the endpoint
// stamps user_id from the VERIFIED session (never from the request body),
// so the UPDATE policy's own-rows scope is the only authority.
{
  const calls: UpsertCall[] = [];
  const forgedEvent = { ...historyEvent, userId: 'victim-user' };
  const response = await historyPost({ locals: locals('user-1', null, calls), request: historyRequest(forgedEvent) } as never);
  assert.equal(response.status, 200);
  assert.equal(calls[0].row.user_id, 'user-1', 'user_id is taken from the verified session, not client input');
  ok(true, '1e. history writes are stamped from the verified session (own-rows policy scope binds)');
}

// ============================================================
// 2. Migration contract — watch_history_update_own
// ============================================================

const migration = read('supabase/migrations/20260921100000_phase1_watch_history_update_policy.sql');

ok(/drop policy if exists watch_history_update_own on public\.watch_history;/.test(migration), '2a. migration is idempotent (drop policy if exists)');
ok(/create policy watch_history_update_own\s*\n\s*on public\.watch_history for update\s*\n\s*to authenticated/.test(migration), '2b. policy is an UPDATE policy on watch_history for the authenticated role');
ok(/using \(user_id = \(select auth\.uid\(\)\)\)/.test(migration), '2c. USING uses the initplan-safe (select auth.uid()) expression scoped to own rows');
ok(/with check \(user_id = \(select auth\.uid\(\)\)\)/.test(migration), '2d. WITH CHECK re-scopes the resulting row to the caller (no cross-user updates)');
ok(!/security definer/i.test(migration), '2e. no security-definer escalation in the migration');
ok(!/grant\s/i.test(migration), '2f. no table-wide grants added (RLS architecture preserved)');

// The conflict target the endpoint relies on must still exist (prior
// migration untouched — verified by diff review; asserted here for the
// contract chain).
const idempotencyMigration = read('supabase/migrations/20260823081000_harden_history_idempotency.sql');
ok(/create unique index if not exists watch_history_user_event_unique_idx\s*\n\s*on public\.watch_history \(user_id, event_key\);/.test(idempotencyMigration), '2g. the (user_id, event_key) unique index (conflict target) remains in place');

// The endpoint source still upserts with the conflict target (wiring not
// accidentally changed by the fix).
const historySource = read('src/routes/api/account/history/+server.ts');
ok(/onConflict: 'user_id,event_key'/.test(historySource), '2h. history endpoint still upserts on (user_id, event_key)');

console.log(`phase1_watch_history_rls_test: ${passed} checks passed (upsert duplicate/retry correctness + UPDATE policy contract)`);
