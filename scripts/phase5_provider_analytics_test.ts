import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchProviders } from '../src/lib/server/analytics/providers';
import { resolvePresetRange } from '../src/lib/shared/analytics-period';

/**
 * Phase 5 — Provider Analytics tests.
 *
 * Covers:
 *   A. Route — /admin/users/providers exists + admin authorization.
 *   B. Date range — period passed to queries, UTC/half-open preserved.
 *   C. Provider taxonomy — provider_selected, provider_switched, watch_start.
 *   D. Provider distinction — selected ≠ actual (watch_start.provider_id = actual).
 *   E. Usage — provider usage aggregation, unique users, watch starts, completions.
 *   F. Switches — switch count, unique switchers, transitions, switch reasons.
 *   G. Success/failure — NOT available (no fake success rate).
 *   H. Identity/privacy — user_id/anonymous_id, no IP, no raw anonymous ID.
 *   I. Query safety — bounded date query, projected columns, no select('*').
 *   J. UI states — empty, error, unavailable metrics.
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
// A. Route — now a Phase 3 redirect stub to /admin/analytics?tab=providers
// ============================================================
// Phase 3: the canonical Analytics workspace (Phase H) owns the provider
// dashboard. The legacy /admin/users/providers/+page.server.ts and +page.svelte
// are redirect stubs. Service contracts (fetchProviders) are tested in §B–K.

const providersServer = read('src/routes/admin/users/providers/+page.server.ts');
const providersServerNoComments = providersServer.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ok(/throw redirect\(303, `\/admin\/analytics\?/.test(providersServer), 'A1. providers server is a redirect stub to /admin/analytics?tab=providers');
ok(!/requireAdmin/.test(providersServerNoComments), 'A2. providers server no longer calls requireAdmin (canonical route handles auth)');
ok(!/fetchProviders/.test(providersServerNoComments), 'A3. providers server no longer calls fetchProviders (canonical route owns the fetch)');
ok(/params\.set\('tab', 'providers'\)/.test(providersServer), 'A4. providers server sets tab=providers in forwarded params');

// A5–A7. Cleanup: client +page.svelte removed — server redirect(303) is
//        sufficient for SSR, client-nav, and no-JS clients. Assert the file is gone.
ok(!existsSync(path.join(REPO_ROOT, 'src/routes/admin/users/providers/+page.svelte')), 'A5. providers client page removed (server redirect is sufficient)');

// AdminShell.svelte was deleted in the post-Phase-3 cleanup (dead code
// after the last consumer migrated to AdminAppShell). The legacy
// users-providers nav entry lived in AdminShell; with the shell gone, the
// canonical Analytics workspace owns the providers dashboard.
ok(!existsSync(path.join(REPO_ROOT, 'src/lib/components/AdminShell.svelte')), 'A8. AdminShell.svelte has been deleted (dead code after Phase 3 migration)');

// ============================================================
// B. Date range — UTC / half-open preserved
// ============================================================

const providersModule = read('src/lib/server/analytics/providers.ts');
ok(/gte\('event_time', range\.start\)/.test(providersModule), 'B1. providers module uses gte(range.start) — half-open interval');
ok(/lt\('event_time', range\.end\)/.test(providersModule), 'B2. providers module uses lt(range.end) — half-open interval');

// ============================================================
// C. Provider taxonomy — provider_selected, provider_switched, watch_start
// ============================================================

ok(/eq\('event_name', 'provider_selected'\)/.test(providersModule), 'C1. selections query uses event_name=provider_selected');
ok(/eq\('event_name', 'provider_switched'\)/.test(providersModule), 'C2. switches query uses event_name=provider_switched');
ok(/eq\('event_name', 'watch_start'\)/.test(providersModule), 'C3. actual usage query uses event_name=watch_start');
ok(/eq\('event_name', 'watch_complete'\)/.test(providersModule), 'C4. completions query uses event_name=watch_complete');

// ============================================================
// D. Provider distinction — selected ≠ actual
// ============================================================

// The module MUST use watch_start.provider_id as the "actual provider"
// (NOT provider_selected.provider_id). This is the critical distinction
// per plan §6. The watch_start query selects provider_id, and the
// usage aggregation counts watch_starts per provider_id separately
// from selections.
ok(/eq\('event_name', 'watch_start'\)/.test(providersModule), 'D1a. actual provider usage query uses event_name=watch_start');
ok(/watch_starts/.test(providersModule), 'D1b. providers module tracks watch_starts separately from selections');
// The watch_start query selects provider_id (the actual playback provider).
const watchStartQueryMatch = providersModule.match(/eq\('event_name', 'watch_start'\)[\s\S]*?\.select\('([^']+)'\)/);
ok(watchStartQueryMatch && /provider_id/.test(watchStartQueryMatch[1]), 'D1c. watch_start query selects provider_id (the actual playback provider)');
// provider_selected is counted as "selections", NOT as "actual usage".
ok(/totalSelections/.test(providersModule), 'D2. provider_selected counted as "selections" (not actual usage)');
ok(/totalWatchStarts/.test(providersModule), 'D3. watch_start counted as "actual usage" (separate from selections)');

// ============================================================
// E. Usage — aggregation, unique users, watch starts, completions
// ============================================================

ok(/usageByProvider|getOrCreate/.test(providersModule), 'E1. providers module aggregates usage by provider_id');
ok(/unique_users/.test(providersModule), 'E2. providers module computes unique_users per provider');
ok(/usage_share/.test(providersModule), 'E3. providers module computes usage_share (percentage)');
ok(/movie_watch_starts|series_watch_starts|anime_watch_starts/.test(providersModule), 'E4. providers module computes movie/series/anime breakdown');

// ============================================================
// F. Switches — count, unique switchers, transitions, reasons
// ============================================================

ok(/totalSwitches/.test(providersModule), 'F1. providers module computes totalSwitches');
ok(/transitionMap/.test(providersModule), 'F2. providers module builds transition map');
ok(/from_provider_id.*to_provider_id|from_provider.*to_provider/.test(providersModule), 'F3. transitions use from_provider_id → to_provider_id from metadata');
ok(/switchReasons/.test(providersModule), 'F4. providers module computes switchReasons');
ok(/metadata.*reason|reason.*metadata/.test(providersModule), 'F5. switch reasons read from metadata.reason');

// ============================================================
// G. Success/failure — NOT available (no fake success rate)
// ============================================================

// playback_success / playback_failed are NOT emitted → success/failure
// must NOT be computed. The module must declare successFailureAvailable = false.
ok(/successFailureAvailable.*false|successFailureAvailable = false/.test(providersModule), 'G1. successFailureAvailable is false (events not emitted)');
ok(!/success_rate|successRate/.test(providersModule.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'G2. NO success_rate computed (no fake success rate)');
ok(!/playback_success|playback_failed/.test(providersModule.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/'playback_success'/g, '').replace(/'playback_failed'/g, '')), 'G3. no query for playback_success/playback_failed events (they are not emitted)');

// The canonical analytics page shows "N/A" / "Not tracked" for success/failure
// (successFailureAvailable is false — events not emitted).
ok(/Not available|not available|unavailable|N\/A|Not tracked/i.test(read('src/routes/admin/analytics/+page.svelte')), 'G4. canonical analytics page shows N/A / Not tracked for success/failure when successFailureAvailable is false');

// ============================================================
// H. Identity/privacy — no IP, no raw anonymous ID
// ============================================================

const providersModuleNoComments = providersModule.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ok(!/ip_address/.test(providersModuleNoComments), 'H1. providers module does not reference raw ip_address');
ok(!/user_agent/.test(providersModuleNoComments), 'H2. providers module does not select/display user_agent');
ok(!/request_id/.test(providersModuleNoComments), 'H3. providers module does not select/display request_id');
ok(!/ip_hash/.test(providersModuleNoComments), 'H4. providers module does not use ip_hash for identity');
ok(/rowIdentity/.test(providersModule), 'H5. providers module uses rowIdentity (user_id OR anonymous_id, no IP)');
// The canonical analytics page (not the legacy redirect stub) does not
// display anonymous IDs.
ok(!/anonymous_id.*display|display.*anonymous_id/i.test(read('src/routes/admin/analytics/+page.svelte')), 'H6. canonical analytics page does not display anonymous_id values');

// ============================================================
// I. Query safety — bounded, projected, no select('*')
// ============================================================

ok(!/select\('\*'\)/.test(providersModule), 'I1. providers module does NOT use select('*') — projects only required columns');
// Transitions are bounded to top 20.
ok(/\.slice\(0, 20\)/.test(providersModule), 'I2. transitions bounded to top 20');
// No client-side Supabase — the canonical analytics page does not import createClient
// (the legacy providers route is a redirect stub with no client-side code at all).
ok(!/createClient|@supabase\/supabase-js/.test(read('src/routes/admin/analytics/+page.svelte')), 'I3. canonical analytics page does NOT import Supabase client (no client-side DB access)');

// ============================================================
// J. UI states — empty, error, unavailable (on canonical analytics page)
// The legacy /admin/users/providers page is now a redirect stub; the
// canonical /admin/analytics?tab=providers page owns the UI states.
// ============================================================

const analyticsPage = read('src/routes/admin/analytics/+page.svelte');
ok(/a2-empty/.test(analyticsPage), 'J1. canonical analytics page uses a2-empty empty-state class');
ok(/role="alert"/.test(analyticsPage), 'J2. canonical analytics page has error state with role="alert"');
ok(/N\/A|Not tracked|unavailable/i.test(analyticsPage), 'J3. canonical analytics page shows unavailable-metric state for success/failure (N/A / Not tracked)');
ok(/a2-empty|a2-empty-inline/.test(analyticsPage), 'J4. canonical analytics page has empty-state classes for zero-data');

// ============================================================
// K. Mock-DB behavioral tests
// ============================================================

type MockEvent = { user_id: string | null; anonymous_id: string; event_name: string; event_time: string; provider_id?: string | null; source_id?: string | null; content_type?: string | null; metadata?: Record<string, unknown> | null };

function createMockClient(options: { events?: MockEvent[]; error?: { code?: string; message?: string } | null }): { client: any } {
  const events = options.events ?? [];
  const client: any = {
    from(_table: string) {
      const state: any = { _filters: {} as Record<string, unknown> };
      const thenable: any = {
        select: () => thenable,
        eq: (col: string, val: unknown) => { state._filters[`${col}_eq`] = val; return thenable; },
        not: (col: string, _op: string, val: unknown) => { state._filters[`${col}_not`] = val; return thenable; },
        gte: (col: string, val: unknown) => { state._filters[`${col}_gte`] = val; return thenable; },
        lt: (col: string, val: unknown) => { state._filters[`${col}_lt`] = val; return thenable; },
        then: (onFulfilled: (v: any) => any, onRejected?: (e: any) => any) => {
          try {
            if (options.error) return Promise.resolve({ data: null, error: options.error, count: null }).then(onFulfilled, onRejected);
            let data = events.filter((e) => {
              for (const [k, v] of Object.entries(state._filters)) {
                if (k === 'event_name_eq' && e.event_name !== v) return false;
                if (k === 'event_time_gte' && e.event_time < (v as string)) return false;
                if (k === 'event_time_lt' && e.event_time >= (v as string)) return false;
                if (k === 'provider_id_not' && v === null && e.provider_id === null) return false;
              }
              return true;
            });
            return Promise.resolve({ data, error: null, count: data.length }).then(onFulfilled, onRejected);
          } catch (e) {
            return Promise.reject(e).then(undefined, onRejected);
          }
        },
      };
      return thenable;
    },
    // Mock getPublicStreamingConfig resolution — the lazy import will
    // fail in the test environment, so provider names will be null.
  };
  return { client };
}

// K1. fetchProviders with no events returns empty result.
{
  const { client } = createMockClient({ events: [] });
  const range = resolvePresetRange('30d');
  const result = await fetchProviders(client, range);
  assert.equal(result.error, null, 'no events → no error');
  assert.equal(result.metrics.totalSelections, 0);
  assert.equal(result.metrics.totalSwitches, 0);
  assert.equal(result.metrics.totalWatchStarts, 0);
  assert.equal(result.usage.length, 0);
}
ok(true, 'K1. fetchProviders returns empty result when no events');

// K2. fetchProviders with provider_selected + watch_start distinguishes selections from actual usage.
{
  const { client } = createMockClient({
    events: [
      // User selects provider A (provider_selected)
      { user_id: 'u1', anonymous_id: 'g1', event_name: 'provider_selected', event_time: '2026-09-20T10:00:00Z', provider_id: 'prov-a', source_id: 'src-a', content_type: 'movie' },
      // User actually watches on provider B (watch_start — the actual provider)
      { user_id: 'u1', anonymous_id: 'g1', event_name: 'watch_start', event_time: '2026-09-20T10:05:00Z', provider_id: 'prov-b', source_id: 'src-b', content_type: 'movie' },
    ],
  });
  const range = resolvePresetRange('30d');
  const result = await fetchProviders(client, range);
  assert.equal(result.metrics.totalSelections, 1, '1 selection (provider A)');
  assert.equal(result.metrics.totalWatchStarts, 1, '1 watch start (provider B — actual)');
  // Provider A has 1 selection, 0 watch starts.
  const provA = result.usage.find((u) => u.provider_id === 'prov-a');
  assert.ok(provA, 'provider A in usage table');
  assert.equal(provA!.selections, 1, 'provider A: 1 selection');
  assert.equal(provA!.watch_starts, 0, 'provider A: 0 actual watch starts (user watched on B)');
  // Provider B has 0 selections, 1 watch start (actual).
  const provB = result.usage.find((u) => u.provider_id === 'prov-b');
  assert.ok(provB, 'provider B in usage table');
  assert.equal(provB!.selections, 0, 'provider B: 0 selections');
  assert.equal(provB!.watch_starts, 1, 'provider B: 1 actual watch start');
}
ok(true, 'K2. fetchProviders distinguishes selections (provider_selected) from actual usage (watch_start.provider_id)');

// K3. fetchProviders with provider_switched builds transitions.
{
  const { client } = createMockClient({
    events: [
      { user_id: 'u1', anonymous_id: 'g1', event_name: 'provider_switched', event_time: '2026-09-20T10:05:00Z', provider_id: 'prov-b', source_id: 'src-b', metadata: { from_provider_id: 'prov-a', to_provider_id: 'prov-b', reason: 'manual_switch' } },
      { user_id: 'u2', anonymous_id: 'g2', event_name: 'provider_switched', event_time: '2026-09-21T10:00:00Z', provider_id: 'prov-b', source_id: 'src-b', metadata: { from_provider_id: 'prov-a', to_provider_id: 'prov-b', reason: 'manual_switch' } },
    ],
  });
  const range = resolvePresetRange('30d');
  const result = await fetchProviders(client, range);
  assert.equal(result.metrics.totalSwitches, 2, '2 total switches');
  assert.equal(result.transitions.length, 1, '1 unique transition (prov-a → prov-b)');
  assert.equal(result.transitions[0].from_provider_id, 'prov-a');
  assert.equal(result.transitions[0].to_provider_id, 'prov-b');
  assert.equal(result.transitions[0].count, 2, 'transition count = 2');
  assert.equal(result.transitions[0].unique_switchers, 2, '2 unique switchers');
  // Switch reasons
  assert.equal(result.switchReasons.length, 1, '1 switch reason');
  assert.equal(result.switchReasons[0].reason, 'manual_switch');
  assert.equal(result.switchReasons[0].count, 2);
}
ok(true, 'K3. fetchProviders builds transitions from provider_switched metadata');

// K4. fetchProviders returns successFailureAvailable = false.
{
  const { client } = createMockClient({ events: [] });
  const range = resolvePresetRange('30d');
  const result = await fetchProviders(client, range);
  assert.equal(result.successFailureAvailable, false, 'success/failure NOT available');
}
ok(true, 'K4. fetchProviders returns successFailureAvailable = false (events not emitted)');

// K5. fetchProviders with a missing-table error returns migrationPending.
{
  const { client } = createMockClient({
    events: [],
    error: { code: '42P01', message: 'relation "public.analytics_events" does not exist' },
  });
  const range = resolvePresetRange('30d');
  const result = await fetchProviders(client, range);
  assert.equal(result.migrationPending, true, 'missing-table error → migrationPending');
  assert.notEqual(result.error, null);
}
ok(true, 'K5. fetchProviders returns migrationPending on missing-table error');

// K6. fetchProviders computes movie/series/anime breakdown per provider.
{
  const { client } = createMockClient({
    events: [
      { user_id: 'u1', anonymous_id: 'g1', event_name: 'watch_start', event_time: '2026-09-20T10:00:00Z', provider_id: 'prov-a', source_id: 'src-a', content_type: 'movie' },
      { user_id: 'u1', anonymous_id: 'g1', event_name: 'watch_start', event_time: '2026-09-20T11:00:00Z', provider_id: 'prov-a', source_id: 'src-a', content_type: 'series' },
      { user_id: 'u2', anonymous_id: 'g2', event_name: 'watch_start', event_time: '2026-09-21T10:00:00Z', provider_id: 'prov-a', source_id: 'src-a', content_type: 'anime' },
    ],
  });
  const range = resolvePresetRange('30d');
  const result = await fetchProviders(client, range);
  const provA = result.usage.find((u) => u.provider_id === 'prov-a');
  assert.ok(provA);
  assert.equal(provA!.movie_watch_starts, 1, '1 movie start');
  assert.equal(provA!.series_watch_starts, 1, '1 series start');
  assert.equal(provA!.anime_watch_starts, 1, '1 anime start');
  assert.equal(provA!.unique_users, 2, '2 unique users');
}
ok(true, 'K6. fetchProviders computes movie/series/anime breakdown per provider');

console.log(`phase5_provider_analytics_test: ${passed} checks passed (route + date range + taxonomy + provider distinction + usage + switches + success/failure + privacy + query safety + UI states + mock-DB behavior)`);
