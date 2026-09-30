import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  listUsers,
  fetchUserDetail,
  USER_FILTERS,
  USER_FILTER_LABELS,
  type UserFilter,
} from '../src/lib/server/analytics/users';
import { MEANINGFUL_ACTIVITY_EVENTS } from '../src/lib/shared/analytics-taxonomy';
import { resolvePresetRange, resolveRangeFromParams } from '../src/lib/shared/analytics-period';

/**
 * Phase 3 — User Management tests.
 *
 * Covers:
 *   1. Admin nav wiring (Users entry added to USERS & ANALYTICS section).
 *   2. Users list route + server load contract.
 *   3. User detail route + server load contract.
 *   4. Server module contract (listUsers, fetchUserDetail, error-safe).
 *   5. Filters (all/active/new/returning).
 *   6. Pagination (server-side, bounded).
 *   7. Search (server-side, case-insensitive partial match).
 *   8. Identity handling (user_id primary, no IP-based stitching).
 *   9. No cross-user data leakage (queries are scoped by user_id).
 *  10. Privacy / data minimization (no raw IP, no raw UA, no request_id).
 *  11. Empty state + error state handling.
 *  12. Stable ordering.
 *  13. URL state behavior (search/filter/page/period in URL).
 *  14. Reuse of Phase 1/2 conventions (MEANINGFUL_ACTIVITY_EVENTS, date range).
 *
 * Test flavor: static-contract + pure-unit + mock-DB (matching the repo's
 * established phase1/phase2 test convention).
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
// 1. Admin nav wiring — Users entry now lives in AdminAppShell
// ============================================================
// AdminShell.svelte was deleted in the post-Phase-3 cleanup (dead code
// after the last consumer, /admin/users/[userId], migrated to AdminAppShell).
// The Users nav entry now lives in AdminAppShell; AdminShell is gone.

ok(!existsSync(path.join(REPO_ROOT, 'src/lib/components/AdminShell.svelte')), '1a. AdminShell.svelte has been deleted (dead code after Phase 3 migration)');

// ============================================================
// 2. Users list route — now a Phase 3 redirect stub to /admin/analytics?tab=users
// ============================================================
// Phase 3: the canonical Analytics workspace (Phase H) owns the user list.
// The legacy /admin/users/+page.server.ts and +page.svelte are redirect
// stubs. Service contracts (listUsers, fetchUserDetail) are tested in §4.

const listServer = read('src/routes/admin/users/+page.server.ts');
// Strip comments before checking for absence of requireAdmin/listUsers so
// that the doc-comment mentions ("canonical route owns the listUsers call")
// don't trip the negative assertions.
const listServerNoComments = listServer.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ok(/throw redirect\(303, `\/admin\/analytics\?/.test(listServer), '2a. users list server is a redirect stub to /admin/analytics?tab=users');
ok(!/requireAdmin/.test(listServerNoComments), '2b. users list server no longer calls requireAdmin (canonical route handles auth)');
ok(!/listUsers/.test(listServerNoComments), '2c. users list server no longer calls listUsers (canonical route owns the fetch)');
ok(/params\.set\('tab', 'users'\)/.test(listServer), '2d. users list server sets tab=users in forwarded params');
ok(/new URLSearchParams\(url\.searchParams\)/.test(listServer), '2e. users list server forwards all URL params (q/filter/page/period) to canonical route');

// 2f–2h. Cleanup: client +page.svelte removed — server redirect(303) is
//         sufficient for SSR, client-nav, and no-JS clients. Assert the file is gone.
ok(!existsSync(path.join(REPO_ROOT, 'src/routes/admin/users/+page.svelte')), '2f. users list client page removed (server redirect is sufficient)');

// ============================================================
// 3. User detail route + server load contract
// ============================================================

const detailServer = read('src/routes/admin/users/[userId]/+page.server.ts');
ok(/requireAdmin\(locals, \{ redirectTo: [`'`]\/admin\/users\//.test(detailServer), '3a. user detail load calls requireAdmin');
ok(/fetchUserDetail\(locals\.supabase,/.test(detailServer), '3b. user detail load calls fetchUserDetail');
ok(/UUID_RE/.test(detailServer), '3c. user detail load validates userId as UUID');
ok(/throw error\(400/.test(detailServer), '3d. user detail load throws 400 for invalid userId');
ok(/throw error\(404/.test(detailServer), '3e. user detail load throws 404 when user not found');
ok(/url\.searchParams\.get\('page'\)/.test(detailServer), '3f. user detail load reads timeline ?page= param');

const detailPage = read('src/routes/admin/users/[userId]/+page.svelte');
ok(/<AdminAppShell active="analytics">/.test(detailPage), '3g. user detail page wraps in AdminAppShell with active="analytics"');
ok(/Account Information/i.test(detailPage) || /Account/.test(detailPage), '3h. user detail page has account information section');
ok(/Activity Summary/i.test(detailPage) || /activity-summary/.test(detailPage) || /ActivitySummary/.test(detailPage) || /activity summary/i.test(detailPage), '3i. user detail page has activity summary section');
ok(/Activity Timeline/i.test(detailPage) || /timeline/.test(detailPage), '3j. user detail page has activity timeline section');
ok(/Viewing History/i.test(detailPage) || /viewing-history/.test(detailPage), '3k. user detail page has viewing history section');
ok(/Guest history/i.test(detailPage) || /guest-history/.test(detailPage), '3l. user detail page has guest history section');
ok(/back-link/.test(detailPage) && /\/admin\/analytics\?tab=users/.test(detailPage), '3m. user detail page has a back-to-users link pointing to canonical /admin/analytics?tab=users');
ok(/AdminEmptyState/.test(detailPage), '3n. user detail page uses AdminEmptyState');
ok(/role="alert"/.test(detailPage), '3o. user detail page has an error state with role="alert"');

// ============================================================
// 4. Server module contract (listUsers, fetchUserDetail)
// ============================================================

const usersModule = read('src/lib/server/analytics/users.ts');
ok(/export async function listUsers\(/.test(usersModule), '4a. users module exports listUsers');
ok(/export async function fetchUserDetail\(/.test(usersModule), '4b. users module exports fetchUserDetail');
ok(/export type UserFilter/.test(usersModule), '4c. users module exports UserFilter type');
ok(/export const USER_FILTERS/.test(usersModule), '4d. users module exports USER_FILTERS array');
ok(/MEANINGFUL_ACTIVITY_EVENTS/.test(usersModule), '4e. users module reuses MEANINGFUL_ACTIVITY_EVENTS (no redefinition)');
ok(/isMissingTableError/.test(usersModule), '4f. users module has isMissingTableError (error-safe)');
ok(/safeErrorMessage/.test(usersModule), '4g. users module has safeErrorMessage (no SQL internals exposed)');
ok(/never throws/i.test(usersModule), '4h. users module documented as never-throwing');
ok(/EMPTY/.test(usersModule) || /empty shape/i.test(usersModule), '4i. users module returns safe empty shape on error');

// ============================================================
// 5. Filters — all/active/new/returning supported
// ============================================================

assert.deepEqual([...USER_FILTERS], ['all', 'active', 'new', 'returning'], '5a. USER_FILTERS has exactly the 4 supported filters');
ok(true, '5a. USER_FILTERS contains all/active/new/returning');
assert.equal(USER_FILTER_LABELS.all, 'All users');
assert.equal(USER_FILTER_LABELS.active, 'Active users');
assert.equal(USER_FILTER_LABELS.new, 'New users');
assert.equal(USER_FILTER_LABELS.returning, 'Returning users');
ok(true, '5b. USER_FILTER_LABELS populated for every filter');

// 5c. The 'active' filter uses MEANINGFUL_ACTIVITY_EVENTS (not arbitrary events).
ok(/in\('event_name', MEANINGFUL_EVENTS_ARRAY\)/.test(usersModule), '5c. active/returning filters use MEANINGFUL_EVENTS_ARRAY');
// 5d. The 'new' filter uses profiles.created_at in the period.
ok(/gte\('created_at', periodStart\)/.test(usersModule) && /lt\('created_at', periodEnd\)/.test(usersModule), '5d. new filter uses profiles.created_at in [periodStart, periodEnd)');
// 5e. The 'returning' filter checks for prior activity before periodStart.
ok(/lt\('event_time', periodStart\)/.test(usersModule), '5e. returning filter checks for activity before periodStart');

// ============================================================
// 6. Pagination — server-side, bounded
// ============================================================

// 6a. listUsers uses .range(from, to) for server-side pagination.
ok(/\.range\(from, to\)/.test(usersModule), '6a. listUsers uses .range(from, to) for server-side pagination');
// 6b. pageSize is bounded (1–100).
ok(/Math\.min\(100,/.test(usersModule) && /Math\.max\(1,/.test(usersModule), '6b. pageSize bounded to 1–100');
// 6c. fetchUserDetail timeline is also paginated.
ok(/timelinePage/.test(usersModule) && /timelinePageSize/.test(usersModule), '6c. fetchUserDetail timeline is paginated');

// ============================================================
// 7. Search — server-side, case-insensitive partial match
// ============================================================

// 7a. listUsers uses ilike for case-insensitive partial match on display_name.
// Email search is handled separately via auth.users (see listUsers doc).
ok(/display_name\.ilike/.test(usersModule), '7a. listUsers uses ilike for case-insensitive partial match on display_name');
// 7b. Search is bounded (200 chars max).
ok(/slice\(0, 200\)/.test(usersModule), '7b. search input bounded to 200 chars');
// 7c. The list server forwards URL params to the canonical route (search is
// URL-driven via ?q= in the canonical /admin/analytics page).
ok(/new URLSearchParams\(url\.searchParams\)/.test(listServer), '7c. users list server forwards URL params (including ?q=) to canonical route');

// ============================================================
// 8. Identity handling — user_id primary, no IP-based stitching
// ============================================================

// 8a. listUsers queries profiles.id (the canonical user identity).
ok(/from\('profiles'\)/.test(usersModule), '8a. listUsers queries the profiles table (canonical user identity)');
// 8b. fetchUserDetail enriches with analytics_events where user_id = userId.
ok(/eq\('user_id', userId\)/.test(usersModule), '8b. fetchUserDetail queries analytics_events scoped by user_id');
// 8c. Guest history uses anonymous_id ↔ user_id co-occurrence (NOT IP).
ok(/anonymous_id/.test(usersModule), '8c. guest history uses anonymous_id (Phase 1 identity model)');
// 8d. NO ip_hash used for identity stitching (only doc comments may mention it).
const usersModuleNoBlockComments = usersModule.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ok(!/ip_hash/.test(usersModuleNoBlockComments), '8d. users module does not use ip_hash for identity (no IP-based stitching — doc comments stripped)');

// ============================================================
// 9. No cross-user data leakage — queries are scoped by user_id
// ============================================================

// 9a. fetchUserDetail queries are scoped by eq('user_id', userId).
ok(/eq\('user_id', userId\)/.test(usersModule), '9a. fetchUserDetail scopes all analytics queries by user_id');
// 9b. The list load returns only the page's users (not the entire population).
ok(/\.range\(from, to\)/.test(usersModule), '9b. listUsers paginates server-side (no full population fetch)');
// 9c. The timeline is scoped by user_id.
ok(/from\('analytics_events'\)[\s\S]*?eq\('user_id', userId\)/.test(usersModule), '9c. timeline query scoped by user_id');
// 9d. The viewing history is scoped by user_id.
ok(/in\('event_name', \['watch_start', 'watch_complete', 'watch_progress'\]\)/.test(usersModule), '9d. viewing history scoped to watch events + user_id');

// ============================================================
// 10. Privacy / data minimization
// ============================================================

// 10a. Raw IP is never stored (Phase 1) and never displayed (Phase 3).
ok(!/ip_address/.test(usersModuleNoBlockComments), '10a. users module does not reference raw ip_address');
// 10b. user_agent is NOT selected or displayed.
ok(!/user_agent/.test(usersModuleNoBlockComments), '10b. users module does not select/display user_agent');
// 10c. request_id is NOT selected or displayed.
ok(!/request_id/.test(usersModuleNoBlockComments), '10c. users module does not select/display request_id');
// 10d. The metadata field is summarized safely (not dumped wholesale).
ok(/eventSummary\(/.test(usersModule), '10d. users module has eventSummary() that extracts only safe sub-fields');
// 10e. Anonymous IDs are NOT displayed in the UI by default.
ok(/NOT displayed/i.test(detailPage) || /anonymous IDs are NOT displayed/i.test(detailPage) || /Anonymous IDs are NOT/i.test(detailPage), '10e. user detail page documents that anonymous IDs are not displayed');

// ============================================================
// 11. Empty state + error state handling
// ============================================================

// 11a. listUsers returns an empty array (not null) when no users.
ok(/users: \[\]/.test(usersModule), '11a. listUsers returns empty array on no results');
// 11b. listUsers returns error field on failure.
ok(/error:/.test(usersModule), '11b. listUsers returns error field on failure');
// 11c. fetchUserDetail returns safe empty shape on error.
ok(/account: null/.test(usersModule), '11c. fetchUserDetail returns account: null on error');
// 11d. The canonical analytics page (not the legacy redirect stub) shows
// an empty state when no users match the search/filter.
ok(/a2-empty/.test(read('src/routes/admin/analytics/+page.svelte')), '11d. canonical analytics page has a2-empty empty-state class (legacy list route is now a redirect stub)');
// 11e. The detail page shows AdminEmptyState when user not found.
ok(/AdminEmptyState/.test(detailPage), '11e. detail page uses AdminEmptyState');

// ============================================================
// 12. Stable ordering
// ============================================================

// 12a. listUsers orders by created_at DESC for stable pagination.
ok(/order\('created_at', \{ ascending: false \}\)/.test(usersModule), '12a. listUsers orders by created_at DESC for stable pagination');
// 12b. listUsers re-sorts by last_active DESC NULLS LAST for display.
ok(/last_active.*localeCompare/.test(usersModule) || /sort\(.*last_active/.test(usersModule), '12b. listUsers re-sorts by last_active DESC NULLS LAST');
// 12c. fetchUserDetail timeline orders by event_time DESC (newest first).
ok(/order\('event_time', \{ ascending: false \}\)/.test(usersModule), '12c. timeline ordered by event_time DESC (newest first)');

// ============================================================
// 13. URL state behavior
// ============================================================

// 13a. List page client removed — server redirect(303) forwards URL params
// to the canonical /admin/analytics page (which owns search/filter/page state).
// (Previously asserted goto() on the deleted +page.svelte; now handled by server redirect.)
ok(!existsSync(path.join(REPO_ROOT, 'src/routes/admin/users/+page.svelte')), '13a. users list client page removed (URL state forwarded via server redirect)');
// 13b. The canonical analytics page owns the search/filter/page URL state
// (the legacy list route is a redirect stub that forwards all params).
ok(/new URLSearchParams\(url\.searchParams\)/.test(listServer), '13b. list server forwards URL params (search/filter/page state preserved across redirect)');
// 13c. Detail page timeline is URL-paginated.
ok(/goto\(/.test(detailPage) && /page/.test(detailPage), '13c. detail page timeline is URL-paginated');

// ============================================================
// 14. Reuse of Phase 1/2 conventions
// ============================================================

// 14a. Reuses MEANINGFUL_ACTIVITY_EVENTS from Phase 1.
ok(/import \{ MEANINGFUL_ACTIVITY_EVENTS \} from '\$lib\/shared\/analytics-taxonomy'/.test(usersModule), '14a. users module imports MEANINGFUL_ACTIVITY_EVENTS from Phase 1');
// 14b. resolveRangeFromParams is imported by the canonical analytics server
// (the legacy list server is now a redirect stub and no longer resolves ranges).
const analyticsServer = read('src/routes/admin/analytics/+page.server.ts');
ok(/import \{.*resolveRangeFromParams.*\} from '\$lib\/shared\/analytics-period'/.test(analyticsServer), '14b. canonical analytics server imports resolveRangeFromParams from Phase 2');
// 14c. Reuses admin shells — detail page uses AdminAppShell (Phase 3),
// list client page is removed (server redirect is sufficient; no shell mounted).
ok(!existsSync(path.join(REPO_ROOT, 'src/routes/admin/users/+page.svelte')), '14c-i. users list client page removed (no shell mounted — server redirect)');
ok(/import AdminAppShell from '\$lib\/components\/admin2\/AdminAppShell\.svelte'/.test(detailPage), '14c-ii. detail page reuses AdminAppShell (Phase 3 admin2 shell)');
// 14d. Reuses admin components — list page is a redirect stub (no components),
// detail page reuses the Phase 1/2/3 admin component library.
ok(/AdminPage/.test(detailPage), '14d-i. detail page reuses AdminPage (admin2 header)');
ok(/AdminEmptyState/.test(detailPage), '14d-ii. detail page reuses AdminEmptyState');
ok(/AdminStatusBadge/.test(detailPage), '14d-iii. detail page reuses AdminStatusBadge');
ok(/AdminMetricCard/.test(detailPage), '14d-iv. detail page reuses AdminMetricCard');
ok(/AdminSection/.test(detailPage), '14d-v. detail page reuses AdminSection');
ok(/AdminDateRangePicker/.test(read('src/lib/components/admin/AdminDateRangePicker.svelte')), '14d-vi. AdminDateRangePicker component still exists (legacy list route is a redirect stub; canonical analytics page uses inline period controls)');
// 14e. Reuses requireAdmin from Phase 1 — detail server still does; the
// legacy list server is now a redirect stub (auth handled by canonical route).
ok(!/requireAdmin/.test(listServerNoComments), '14e-i. list server is a redirect stub (no requireAdmin — canonical route handles auth)');
ok(/import \{ requireAdmin \} from '\$lib\/server\/streaming\/admin-auth'/.test(detailServer), '14e-ii. detail server reuses requireAdmin');

// ============================================================
// 15. Mock-DB behavioral tests — listUsers + fetchUserDetail
// ============================================================

// Build a mock Supabase client that records calls + returns canned data.
// This mirrors the repo's mock-DB test convention (see admin_reorder_test.ts).

type SelectCall = { table: string; filters: Record<string, unknown>; range?: [number, number]; order?: string };

function createMockClient(options: {
  profiles?: Array<{ id: string; email: string | null; display_name: string | null; role: string; created_at: string; updated_at: string }>;
  authUsers?: Array<{ id: string; email: string | null }>;
  analyticsEvents?: Array<{ user_id: string | null; anonymous_id: string; event_name: string; event_time: string; content_id?: string | null; content_type?: string | null; metadata?: Record<string, unknown> | null; event_id?: string }>;
  analyticsSessions?: Array<{ user_id: string; session_id: string; last_activity_at: string }>;
  error?: { code?: string; message?: string } | null;
}): {
  client: any;
  selects: SelectCall[];
} {
  const selects: SelectCall[] = [];

  // A deferred-thenable builder: returns an object that is BOTH chainable
  // (supports .order/.range/.eq/.in/...) AND thenable (awaitable). The
  // actual data resolution happens on await. This mirrors the real
  // Supabase JS client's postgrest-builder behavior.
  function buildChain(table: string): any {
    const state: any = {
      _table: table,
      _filters: {} as Record<string, unknown>,
      _range: undefined as [number, number] | undefined,
      _order: undefined as string | undefined,
      _count: undefined as 'exact' | undefined,
      _maybeSingle: false,
    };

    const resolve = (): { data: any; error: any; count: any } => {
      selects.push({ table, filters: { ...state._filters }, range: state._range, order: state._order });
      if (options.error) {
        return { data: null, error: options.error, count: null };
      }
      let data: any[] = [];
      if (table === 'profiles' && options.profiles) {
        data = options.profiles.filter((p) => {
          for (const [k, v] of Object.entries(state._filters)) {
            if (k === 'id_in') { if (!(v as string[]).includes(p.id)) return false; }
            else if (k === 'created_at_gte') { if (p.created_at < (v as string)) return false; }
            else if (k === 'created_at_lt') { if (p.created_at >= (v as string)) return false; }
          }
          return true;
        });
      } else if (table === 'analytics_events' && options.analyticsEvents) {
        data = options.analyticsEvents.filter((e) => {
          for (const [k, v] of Object.entries(state._filters)) {
            if (k === 'user_id_eq' && e.user_id !== v) return false;
            if (k === 'user_id_in' && (!e.user_id || !(v as string[]).includes(e.user_id))) return false;
            if (k === 'anonymous_id_in' && !(v as string[]).includes(e.anonymous_id)) return false;
            if (k === 'event_name_in' && !(v as string[]).includes(e.event_name)) return false;
            if (k === 'event_time_gte' && e.event_time < (v as string)) return false;
            if (k === 'event_time_lt' && e.event_time >= (v as string)) return false;
          }
          return true;
        });
      } else if (table === 'analytics_sessions' && options.analyticsSessions) {
        data = options.analyticsSessions.filter((s) => {
          for (const [k, v] of Object.entries(state._filters)) {
            if (k === 'user_id_in' && !(v as string[]).includes(s.user_id)) return false;
            if (k === 'user_id_eq' && s.user_id !== v) return false;
          }
          return true;
        });
      } else if (table === 'users' && options.authUsers) {
        // auth.users — accessed via .schema('auth').from('users')
        data = options.authUsers.filter((u) => {
          for (const [k, v] of Object.entries(state._filters)) {
            if (k === 'id_in' && !(v as string[]).includes(u.id)) return false;
            if (k === 'id_eq' && u.id !== v) return false;
          }
          return true;
        });
      }
      // Apply ordering (simple string sort on the order column).
      if (state._order) {
        const col = state._order;
        data = [...data].sort((a, b) => {
          const av = (a as any)[col] ?? '';
          const bv = (b as any)[col] ?? '';
          if (av < bv) return -1;
          if (av > bv) return 1;
          return 0;
        });
      }
      // Apply range.
      if (state._range) {
        data = data.slice(state._range[0], state._range[1] + 1);
      }
      // maybeSingle: return the first row (or null).
      if (state._maybeSingle) {
        return { data: data[0] ?? null, error: null, count: null };
      }
      return { data, error: null, count: state._count === 'exact' ? data.length : null };
    };

    // Build a thenable that also supports chaining.
    const thenable: any = {
      select: (_cols?: string, opts?: { count?: 'exact' }) => {
        state._count = opts?.count;
        return thenable;
      },
      eq: (col: string, val: unknown) => { state._filters[`${col}_eq`] = val; return thenable; },
      in: (col: string, vals: unknown[]) => { state._filters[`${col}_in`] = vals; return thenable; },
      neq: (col: string, val: unknown) => { state._filters[`${col}_neq`] = val; return thenable; },
      not: (col: string, _op: string, val: unknown) => { state._filters[`${col}_not`] = val; return thenable; },
      is: (col: string, val: unknown) => { state._filters[`${col}_is`] = val; return thenable; },
      gte: (col: string, val: unknown) => { state._filters[`${col}_gte`] = val; return thenable; },
      lt: (col: string, val: unknown) => { state._filters[`${col}_lt`] = val; return thenable; },
      ilike: (col: string, val: string) => { state._filters[`${col}_ilike`] = val; return thenable; },
      or: (filter: string) => { state._filters['_or'] = filter; return thenable; },
      order: (col: string, _opts?: { ascending?: boolean }) => { state._order = col; return thenable; },
      range: (from: number, to: number) => { state._range = [from, to]; return thenable; },
      maybeSingle: () => { state._maybeSingle = true; return thenable; },
      then: (onFulfilled: (v: any) => any, onRejected?: (e: any) => any) => {
        try {
          return Promise.resolve(resolve()).then(onFulfilled, onRejected);
        } catch (e) {
          return Promise.reject(e).then(undefined, onRejected);
        }
      },
    };
    return thenable;
  }

  const client: any = {
    from(table: string) { return buildChain(table); },
    schema(_schema: string) {
      // Return a client-like object whose .from() builds a chain on the
      // given table (the mock treats auth.users the same as any table).
      return { from(table: string) { return buildChain(table); } };
    },
  };
  return { client, selects };
}

// 15a. listUsers with no users returns empty result.
{
  const { client } = createMockClient({ profiles: [], analyticsEvents: [], analyticsSessions: [] });
  const range = resolvePresetRange('30d');
  const result = await listUsers(client, client, {}, range.start, range.end);
  assert.equal(result.users.length, 0, 'no profiles → empty users list');
  assert.equal(result.error, null, 'no error when no users');
}
ok(true, '15a. listUsers returns empty result when no users');

// 15b. listUsers with one profile + no analytics returns the user with null activity.
{
  const { client } = createMockClient({
    profiles: [
      { id: 'u1', email: null, display_name: 'Alice', role: 'user', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' },
    ],
    authUsers: [
      { id: 'u1', email: 'a@b.com' },
    ],
    analyticsEvents: [],
    analyticsSessions: [],
  });
  const range = resolvePresetRange('30d');
  const result = await listUsers(client, client, {}, range.start, range.end);
  assert.equal(result.users.length, 1, 'one profile → one user');
  assert.equal(result.users[0].id, 'u1');
  assert.equal(result.users[0].email, 'a@b.com', 'email fetched from auth.users');
  assert.equal(result.users[0].last_active, null, 'no analytics → last_active is null');
  assert.equal(result.users[0].first_active, null, 'no analytics → first_active is null');
  assert.equal(result.users[0].session_count, 0);
  assert.equal(result.users[0].watch_starts, 0);
}
ok(true, '15b. listUsers returns user with null activity when no analytics');

// 15c. listUsers with a missing-table error returns migrationPending.
{
  const { client } = createMockClient({
    profiles: [],
    analyticsEvents: [],
    analyticsSessions: [],
    error: { code: '42P01', message: 'relation "public.analytics_events" does not exist' },
  });
  const range = resolvePresetRange('30d');
  const result = await listUsers(client, client, { filter: "active" }, range.start, range.end);
  assert.equal(result.migrationPending, true, 'missing-table error → migrationPending');
  assert.notEqual(result.error, null, 'missing-table error → error message');
  assert.equal(result.users.length, 0);
}
ok(true, '15c. listUsers returns migrationPending on missing-table error');

// 15d. fetchUserDetail with a non-existent user returns "User not found" error.
{
  const { client } = createMockClient({
    profiles: [],
    analyticsEvents: [],
    analyticsSessions: [],
  });
  const result = await fetchUserDetail(client, client, "nonexistent-user-id", {});
  assert.equal(result.account, null);
  assert.equal(result.error, 'User not found.');
}
ok(true, '15d. fetchUserDetail returns "User not found" for non-existent user');

// 15e. fetchUserDetail with a valid user returns the account + activity.
{
  const { client } = createMockClient({
    profiles: [
      { id: 'u1', email: null, display_name: 'Alice', role: 'user', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' },
    ],
    authUsers: [
      { id: 'u1', email: 'a@b.com' },
    ],
    analyticsEvents: [
      { user_id: 'u1', anonymous_id: 'g1', event_name: 'search', event_time: '2026-09-20T10:00:00Z', event_id: 'e1', metadata: { query: 'batman' } },
      { user_id: 'u1', anonymous_id: 'g1', event_name: 'watch_start', event_time: '2026-09-21T11:00:00Z', event_id: 'e2', content_id: 'movie-550', content_type: 'movie', metadata: { title: 'Batman Begins' } },
      { user_id: 'u1', anonymous_id: 'g1', event_name: 'watch_complete', event_time: '2026-09-21T13:00:00Z', event_id: 'e3', content_id: 'movie-550', content_type: 'movie', metadata: { title: 'Batman Begins' } },
    ],
    analyticsSessions: [
      { user_id: 'u1', session_id: 's1', last_activity_at: '2026-09-21T13:00:00Z' },
    ],
  });
  const result = await fetchUserDetail(client, client, "u1", {});
  assert.ok(result.account, 'account present');
  assert.equal(result.account!.id, 'u1');
  assert.equal(result.account!.email, 'a@b.com', 'email fetched from auth.users');
  // Activity summary
  assert.equal(result.activitySummary.watch_starts, 1, 'one watch_start');
  assert.equal(result.activitySummary.completed_watches, 1, 'one watch_complete');
  assert.equal(result.activitySummary.total_sessions, 1, 'one session');
  assert.ok(result.activitySummary.active_days >= 1, 'at least 1 active day');
  // Timeline
  assert.ok(result.timeline.events.length > 0, 'timeline has events');
  // Viewing history
  assert.ok(result.viewingHistory.length > 0, 'viewing history has entries');
  assert.equal(result.viewingHistory[0].content_id, 'movie-550');
  assert.equal(result.viewingHistory[0].completed, true);
}
ok(true, '15e. fetchUserDetail returns account + activity + timeline + viewing for valid user');

// 15f. listUsers does NOT fetch the entire population (pagination enforced).
{
  const { client, selects } = createMockClient({
    profiles: Array.from({ length: 50 }, (_, i) => ({
      id: `u${i}`,
      email: `user${i}@b.com`,
      display_name: `User ${i}`,
      role: 'user',
      created_at: '2026-09-01T00:00:00Z',
      updated_at: '2026-09-01T00:00:00Z',
    })),
    analyticsEvents: [],
    analyticsSessions: [],
  });
  const range = resolvePresetRange('30d');
  await listUsers(client, client, { page: 1, pageSize: 25 }, range.start, range.end);
  // Verify the profiles query used .range()
  const profilesSelect = selects.find((s) => s.table === 'profiles');
  assert.ok(profilesSelect, 'a profiles query was issued');
  assert.ok(profilesSelect!.range, 'profiles query used .range() (server-side pagination)');
}
ok(true, '15f. listUsers uses server-side pagination (does not fetch entire population)');

// 15g. The 'all' filter does NOT pre-compute the active-user set for the whole DB.
{
  const { client, selects } = createMockClient({
    profiles: [
      { id: 'u1', email: 'a@b.com', display_name: 'Alice', role: 'user', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' },
    ],
    analyticsEvents: [],
    analyticsSessions: [],
  });
  const range = resolvePresetRange('30d');
  await listUsers(client, client, { filter: "all" }, range.start, range.end);
  // The 'all' filter should NOT issue an analytics_events query for ALL users
  // (only for the page users, in the enrichment step).
  const analyticsSelects = selects.filter((s) => s.table === 'analytics_events');
  // Enrichment queries are scoped to pageUserIds (bounded by pageSize).
  for (const s of analyticsSelects) {
    const userIds = s.filters['user_id_in'] as string[] | undefined;
    if (userIds) {
      assert.ok(userIds.length <= 25, `analytics enrichment scoped to ≤25 user_ids (got ${userIds.length})`);
    }
  }
}
ok(true, '15g. the "all" filter does not pre-compute active-user set for the whole DB (bounded enrichment)');

console.log(`phase3_user_management_test: ${passed} checks passed (admin nav + routes + server module + filters + pagination + search + identity + privacy + states + ordering + URL state + Phase 1/2 reuse + mock-DB behavior)`);
