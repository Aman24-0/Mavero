import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ANALYTICS_PERIOD_PRESETS,
  ANALYTICS_PERIOD_LABELS,
  isAnalyticsPeriodPreset,
  resolvePresetRange,
  resolveCustomRange,
  resolveRangeFromParams,
  rangeDays,
  chartGranularity,
  rangeBuckets,
  formatUtcDate,
  formatUtcDateTime,
  type AnalyticsPeriodPreset,
} from '../src/lib/shared/analytics-period';
import { MEANINGFUL_ACTIVITY_EVENTS, isMeaningfulActivityEvent } from '../src/lib/shared/analytics-taxonomy';

/**
 * Phase 2 — Overview Dashboard tests.
 *
 * Covers:
 *   1. Date-range parsing (all 7 presets + custom).
 *   2. Period math (24h, 7d, 30d, 3m, 6m, 1y).
 *   3. Custom date range (from/to, clamping, invalid handling).
 *   4. UTC / half-open / boundary conventions.
 *   5. Chart granularity selection (day/week/month).
 *   6. Bucket generation.
 *   7. Meaningful-activity set (the "active user" definition).
 *   8. Admin nav wiring (User Management section added).
 *   9. Overview route + server load contract.
 *  10. Overview query module contract (consolidated fetch, error-safe).
 *  11. Components present (date-range picker, trend chart, funnel).
 *  12. Authorization (requireAdmin gate on the overview load).
 *  13. Zero-data handling (empty state shape).
 *  14. No double-counting (unique identity deduplication logic).
 *
 * Test flavor: static-contract + pure-unit (matching the repo's
 * established `phase1_*_test.ts` / `admin_nav_test.ts` convention).
 */

let passed = 0;
function ok(condition: unknown, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// Fixed "now" for deterministic date-math assertions.
const NOW = new Date('2026-09-26T12:00:00.000Z');

// ============================================================
// 1. Period presets — the 7 mandated presets exist
// ============================================================

// 1a. The preset list matches the plan's 7 required options.
const expectedPresets = ['24h', '7d', '30d', '3m', '6m', '1y', 'custom'];
assert.deepEqual([...ANALYTICS_PERIOD_PRESETS], expectedPresets);
ok(true, '1a. ANALYTICS_PERIOD_PRESETS contains exactly the 7 mandated presets (24h, 7d, 30d, 3m, 6m, 1y, custom)');

// 1b. Labels are populated for every preset.
for (const p of ANALYTICS_PERIOD_PRESETS) {
  assert.ok(typeof ANALYTICS_PERIOD_LABELS[p] === 'string' && ANALYTICS_PERIOD_LABELS[p].length > 0, `${p} has a label`);
}
ok(true, '1b. every preset has a non-empty label');

// 1c. isAnalyticsPeriodPreset validates correctly.
assert.equal(isAnalyticsPeriodPreset('7d'), true);
assert.equal(isAnalyticsPeriodPreset('custom'), true);
assert.equal(isAnalyticsPeriodPreset('bogus'), false);
assert.equal(isAnalyticsPeriodPreset(null), false);
assert.equal(isAnalyticsPeriodPreset(123), false);
ok(true, '1c. isAnalyticsPeriodPreset accepts known presets, rejects unknowns');

// ============================================================
// 2. Preset math — each preset resolves to the correct duration
// ============================================================

// 2a. 24h preset = 24-hour window ending at `now`.
{
  const r = resolvePresetRange('24h', NOW);
  const startMs = new Date(r.start).getTime();
  const endMs = new Date(r.end).getTime();
  const diffMs = endMs - startMs;
  assert.equal(diffMs, 24 * 60 * 60 * 1000, '24h preset = exactly 24 hours');
  assert.equal(r.end, NOW.toISOString(), '24h preset end = now');
  assert.equal(r.preset, '24h');
}
ok(true, '2a. 24h preset resolves to a 24-hour window ending at now');

// 2b. 7d preset = 7×24h = 168h.
{
  const r = resolvePresetRange('7d', NOW);
  const diffMs = new Date(r.end).getTime() - new Date(r.start).getTime();
  assert.equal(diffMs, 7 * 24 * 60 * 60 * 1000, '7d preset = exactly 7 days');
}
ok(true, '2b. 7d preset resolves to a 7-day window');

// 2c. 30d preset = 30×24h = 720h.
{
  const r = resolvePresetRange('30d', NOW);
  const diffMs = new Date(r.end).getTime() - new Date(r.start).getTime();
  assert.equal(diffMs, 30 * 24 * 60 * 60 * 1000, '30d preset = exactly 30 days');
}
ok(true, '2c. 30d preset resolves to a 30-day window');

// 2d. 3m preset = 90×24h.
{
  const r = resolvePresetRange('3m', NOW);
  const diffMs = new Date(r.end).getTime() - new Date(r.start).getTime();
  assert.equal(diffMs, 90 * 24 * 60 * 60 * 1000, '3m preset = exactly 90 days');
}
ok(true, '2d. 3m preset resolves to a 90-day window');

// 2e. 6m preset = 180×24h.
{
  const r = resolvePresetRange('6m', NOW);
  const diffMs = new Date(r.end).getTime() - new Date(r.start).getTime();
  assert.equal(diffMs, 180 * 24 * 60 * 60 * 1000, '6m preset = exactly 180 days');
}
ok(true, '2e. 6m preset resolves to a 180-day window');

// 2f. 1y preset = 365×24h.
{
  const r = resolvePresetRange('1y', NOW);
  const diffMs = new Date(r.end).getTime() - new Date(r.start).getTime();
  assert.equal(diffMs, 365 * 24 * 60 * 60 * 1000, '1y preset = exactly 365 days');
}
ok(true, '2f. 1y preset resolves to a 365-day window');

// 2g. All preset ranges are half-open [start, end) with end = now.
for (const p of ['24h', '7d', '30d', '3m', '6m', '1y'] as const) {
  const r = resolvePresetRange(p, NOW);
  assert.ok(r.start < r.end, `${p}: start < end (half-open)`);
  assert.equal(r.end, NOW.toISOString(), `${p}: end = now`);
}
ok(true, '2g. all preset ranges are half-open [start, end) with end = now');

// ============================================================
// 3. Custom date range — from/to, clamping, invalid handling
// ============================================================

// 3a. Valid custom range.
{
  const r = resolveCustomRange('2026-01-01', '2026-01-31', NOW);
  assert.ok(r !== null, 'valid custom range resolves');
  assert.equal(r!.preset, 'custom');
  assert.equal(r!.start, '2026-01-01T00:00:00.000Z', 'from = start-of-day UTC');
  assert.equal(r!.end, '2026-01-31T23:59:59.999Z', 'to = end-of-day UTC');
}
ok(true, '3a. valid custom range resolves with from=start-of-day, to=end-of-day UTC');

// 3b. Invalid custom range (from > to) returns null.
{
  const r = resolveCustomRange('2026-02-01', '2026-01-01', NOW);
  assert.equal(r, null, 'from > to returns null');
}
ok(true, '3b. custom range with from > to returns null');

// 3c. Invalid date strings return null.
{
  const r = resolveCustomRange('not-a-date', '2026-01-01', NOW);
  assert.equal(r, null, 'invalid from returns null');
  const r2 = resolveCustomRange('2026-01-01', 'not-a-date', NOW);
  assert.equal(r2, null, 'invalid to returns null');
}
ok(true, '3c. invalid date strings return null');

// 3d. Future `to` is clamped to now.
{
  const future = new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000);
  const futureStr = future.toISOString().slice(0, 10);
  const r = resolveCustomRange('2026-01-01', futureStr, NOW);
  assert.ok(r !== null);
  assert.ok(new Date(r!.end).getTime() <= NOW.getTime(), 'future `to` clamped to now');
}
ok(true, '3d. custom `to` in the future is clamped to now');

// 3e. `from` more than 2 years ago is clamped to 2 years ago.
{
  const r = resolveCustomRange('2020-01-01', '2026-09-26', NOW);
  assert.ok(r !== null);
  const twoYearsAgoMs = NOW.getTime() - 2 * 365 * 24 * 60 * 60 * 1000;
  assert.ok(new Date(r!.start).getTime() >= twoYearsAgoMs, '`from` clamped to 2 years ago');
}
ok(true, '3e. custom `from` more than 2 years ago is clamped');

// ============================================================
// 4. resolveRangeFromParams — URL search-param parsing
// ============================================================

// 4a. Preset from URL.
{
  const params = new URLSearchParams('period=7d');
  const { range, preset } = resolveRangeFromParams(params);
  assert.equal(preset, '7d');
  assert.equal(range.preset, '7d');
}
ok(true, '4a. resolveRangeFromParams reads preset from ?period=');

// 4b. Custom from URL.
{
  const params = new URLSearchParams('period=custom&from=2026-01-01&to=2026-01-31');
  const { range, preset, from, to } = resolveRangeFromParams(params);
  assert.equal(preset, 'custom');
  assert.equal(from, '2026-01-01');
  assert.equal(to, '2026-01-31');
  assert.equal(range.preset, 'custom');
}
ok(true, '4b. resolveRangeFromParams reads custom range from ?period=custom&from=...&to=...');

// 4c. Absent params → default preset (30d).
{
  const params = new URLSearchParams();
  const { range, preset } = resolveRangeFromParams(params);
  assert.equal(preset, '30d');
  assert.equal(range.preset, '30d');
}
ok(true, '4c. absent params → default preset 30d');

// 4d. Invalid preset → default.
{
  const params = new URLSearchParams('period=bogus');
  const { preset } = resolveRangeFromParams(params);
  assert.equal(preset, '30d', 'invalid preset falls back to default');
}
ok(true, '4d. invalid preset value falls back to default');

// 4e. Custom without from/to → default.
{
  const params = new URLSearchParams('period=custom');
  const { preset } = resolveRangeFromParams(params);
  assert.equal(preset, '30d', 'custom without from/to falls back to default');
}
ok(true, '4e. custom preset without from/to falls back to default');

// ============================================================
// 5. Chart granularity — day / week / month based on range size
// ============================================================

// 5a. Short range (≤60 days) → daily granularity.
{
  const r = resolvePresetRange('30d', NOW);
  assert.equal(chartGranularity(r), 'day', '30d range → daily');
}
ok(true, '5a. ≤60-day range → daily granularity');

// 5b. Medium range (61–180 days) → weekly granularity.
{
  const r = resolvePresetRange('3m', NOW); // 90 days
  assert.equal(chartGranularity(r), 'week', '90-day range → weekly');
}
ok(true, '5b. 61–180-day range → weekly granularity');

// 5c. Long range (>180 days) → monthly granularity.
{
  const r = resolvePresetRange('1y', NOW); // 365 days
  assert.equal(chartGranularity(r), 'month', '365-day range → monthly');
}
ok(true, '5c. >180-day range → monthly granularity');

// ============================================================
// 6. Bucket generation — correct count + alignment
// ============================================================

// 6a. 7d range → 7 daily buckets (or 8 if the range crosses a UTC midnight boundary).
{
  const r = resolvePresetRange('7d', NOW);
  const buckets = rangeBuckets(r);
  // Buckets are aligned to UTC midnight, so a 7d window starting at
  // 12:00 UTC spans 8 calendar days (partial first + partial last).
  // The bucket count is the number of UTC midnights in [start, end).
  assert.ok(buckets.length >= 7 && buckets.length <= 8, `7d range → 7-8 daily buckets (got ${buckets.length})`);
  for (const b of buckets) {
    assert.ok(b.start < b.end, 'bucket start < end');
    assert.ok(b.label.length === 10, 'daily bucket label is YYYY-MM-DD');
  }
}
ok(true, '6a. 7d range generates daily buckets with YYYY-MM-DD labels');

// 6b. 1y range → 12-13 monthly buckets.
{
  const r = resolvePresetRange('1y', NOW);
  const buckets = rangeBuckets(r);
  assert.ok(buckets.length >= 12 && buckets.length <= 13, `1y range → 12-13 monthly buckets (got ${buckets.length})`);
  for (const b of buckets) {
    assert.ok(b.label.length === 7, 'monthly bucket label is YYYY-MM');
  }
}
ok(true, '6b. 1y range generates monthly buckets with YYYY-MM labels');

// ============================================================
// 7. rangeDays + formatUtcDate helpers
// ============================================================

// 7a. rangeDays returns the day count.
{
  const r = resolvePresetRange('7d', NOW);
  const days = rangeDays(r);
  assert.ok(days === 7 || days === 8, `7d range → 7-8 days (got ${days})`);
}
ok(true, '7a. rangeDays returns the day count');

// 7b. formatUtcDate returns a readable UTC date string.
{
  const formatted = formatUtcDate('2026-09-26T12:00:00.000Z');
  assert.ok(formatted.includes('Sep') && formatted.includes('2026'), `formatUtcDate includes month + year (got "${formatted}")`);
}
ok(true, '7b. formatUtcDate returns a readable UTC date string');

// 7c. formatUtcDateTime includes time + UTC.
{
  const formatted = formatUtcDateTime('2026-09-26T14:30:00.000Z');
  assert.ok(formatted.includes('UTC'), `formatUtcDateTime includes UTC marker (got "${formatted}")`);
}
ok(true, '7c. formatUtcDateTime includes the UTC marker');

// ============================================================
// 8. Meaningful-activity set — the "active user" definition
// ============================================================

// 8a. Pure page-load events are excluded.
assert.equal(isMeaningfulActivityEvent('app_open'), false, 'app_open excluded');
assert.equal(isMeaningfulActivityEvent('session_start'), false, 'session_start excluded');
assert.equal(isMeaningfulActivityEvent('session_end'), false, 'session_end excluded');
ok(true, '8a. app_open / session_start / session_end are NOT meaningful (excludes page loads)');

// 8b. Discovery + playback + feature events are meaningful.
assert.equal(isMeaningfulActivityEvent('search'), true);
assert.equal(isMeaningfulActivityEvent('detail_open'), true);
assert.equal(isMeaningfulActivityEvent('watch_start'), true);
assert.equal(isMeaningfulActivityEvent('watch_complete'), true);
assert.equal(isMeaningfulActivityEvent('provider_selected'), true);
assert.equal(isMeaningfulActivityEvent('favorite_added'), true);
assert.equal(isMeaningfulActivityEvent('download_started'), true);
ok(true, '8b. discovery / playback / feature events are meaningful');

// 8c. The set is non-empty (otherwise every user would be "inactive").
assert.ok(MEANINGFUL_ACTIVITY_EVENTS.size >= 10, `MEANINGFUL_ACTIVITY_EVENTS has ≥10 members (got ${MEANINGFUL_ACTIVITY_EVENTS.size})`);
ok(true, '8c. MEANINGFUL_ACTIVITY_EVENTS is non-empty (≥10 events)');

// ============================================================
// 9. Admin nav wiring — User Management section added
// ============================================================

const adminShell = read('src/lib/components/AdminShell.svelte');
ok(/usersLinks/.test(adminShell), '9a. AdminShell defines a usersLinks array');
ok(/id: 'users-overview'/.test(adminShell), '9b. usersLinks contains the users-overview entry');
ok(/href: '\/admin\/users\/overview'/.test(adminShell), '9c. users-overview links to /admin/users/overview');
ok(/Users &amp; Analytics/.test(adminShell), '9d. Users & Analytics section label rendered');
ok(/users-section-label/.test(adminShell), '9e. users-section-label CSS class applied');
// The existing Workspace links are untouched (test-locked).
ok(/\{ id: 'overview', label: 'Overview', href: '\/admin'/.test(adminShell), '9f. existing Workspace Overview link preserved');
ok(/\{ id: 'providers', label: 'Providers', href: '\/admin\/providers'/.test(adminShell), '9g. existing Workspace Providers link preserved');
// The `active` prop type now includes 'users-overview'.
ok(/users-overview/.test(adminShell), '9h. active prop type includes users-overview');

// ============================================================
// 10. Overview route + server load contract
// ============================================================

const overviewServer = read('src/routes/admin/users/overview/+page.server.ts');
ok(/requireAdmin\(locals, \{ redirectTo: '\/admin\/users\/overview' \}\)/.test(overviewServer), '10a. overview load calls requireAdmin with correct redirect');
ok(/fetchOverview\(locals\.supabase, range/.test(overviewServer), '10b. overview load calls fetchOverview with locals.supabase + range');
ok(/resolveRangeFromParams\(url\.searchParams/.test(overviewServer), '10c. overview load resolves range from URL search params');
ok(/presetList/.test(overviewServer), '10d. overview load returns presetList for the date-range picker');
// Trend mode + metric are validated against closed sets.
ok(/validModes/.test(overviewServer) && /validMetrics/.test(overviewServer), '10e. overview load validates trend mode + metric against closed sets');

const overviewPage = read('src/routes/admin/users/overview/+page.svelte');
ok(/<AdminShell active="users-overview">/.test(overviewPage), '10f. overview page wraps in AdminShell with active="users-overview"');
ok(/AdminDateRangePicker/.test(overviewPage), '10g. overview page renders AdminDateRangePicker');
ok(/AdminTrendChart/.test(overviewPage), '10h. overview page renders AdminTrendChart');
ok(/AdminFunnel/.test(overviewPage), '10i. overview page renders AdminFunnel');
ok(/Total Users/.test(overviewPage), '10j. overview page has Total Users card');
ok(/Active Users/.test(overviewPage), '10k. overview page has Active Users card');
ok(/New Users/.test(overviewPage), '10l. overview page has New Users card');
ok(/Returning Users/.test(overviewPage), '10m. overview page has Returning Users card');
ok(/Guest Reach/.test(overviewPage), '10n. overview page has Guest Reach card');
ok(/Logged-in Reach/.test(overviewPage), '10o. overview page has Logged-in Reach card');
ok(/Guest Active/.test(overviewPage), '10p. overview page has Guest Active card');
ok(/Logged-in Active/.test(overviewPage), '10q. overview page has Logged-in Active card');
ok(/DAU/.test(overviewPage), '10r. overview page has DAU card');
ok(/WAU/.test(overviewPage), '10s. overview page has WAU card');
ok(/MAU/.test(overviewPage), '10t. overview page has MAU card');
ok(/DAU \/ MAU/.test(overviewPage), '10u. overview page has DAU/MAU stickiness card');
ok(/Guest → Account Conversion/.test(overviewPage), '10v. overview page has Guest→Account funnel section');

// ============================================================
// 11. Overview query module contract
// ============================================================

const overviewModule = read('src/lib/server/analytics/overview.ts');
ok(/export async function fetchOverview/.test(overviewModule), '11a. overview module exports fetchOverview');
ok(/MEANINGFUL_ACTIVITY_EVENTS/.test(overviewModule), '11b. overview module uses MEANINGFUL_ACTIVITY_EVENTS (no redefinition)');
ok(/EMPTY_OVERVIEW_METRICS/.test(overviewModule), '11c. overview module defines EMPTY_OVERVIEW_METRICS (safe empty shape)');
ok(/isMissingTableError/.test(overviewModule), '11d. overview module detects missing-table errors (migration-pending state)');
ok(/migrationPending/.test(overviewModule), '11e. overview module returns migrationPending flag');
ok(/never throws/.test(overviewModule) || /never throws/.test(overviewModule.toLowerCase()), '11f. overview module documented as never-throwing');
// DAU/WAU/MAU use distinct-identity logic (not sum-of-DAU).
ok(/dauStart/.test(overviewModule) && /wauStart/.test(overviewModule) && /mauStart/.test(overviewModule), '11g. DAU/WAU/MAU use separate window starts (not sum-of-DAU)');

// ============================================================
// 12. Components present
// ============================================================

ok(read('src/lib/components/admin/AdminDateRangePicker.svelte').length > 0, '12a. AdminDateRangePicker component exists');
ok(read('src/lib/components/admin/AdminTrendChart.svelte').length > 0, '12b. AdminTrendChart component exists');
ok(read('src/lib/components/admin/AdminFunnel.svelte').length > 0, '12c. AdminFunnel component exists');

// 12d. Trend chart uses inline SVG (no charting library dependency).
const chartSrc = read('src/lib/components/admin/AdminTrendChart.svelte');
ok(/<svg/.test(chartSrc), '12d. AdminTrendChart uses inline SVG');
ok(/role="img"/.test(chartSrc), '12e. AdminTrendChart has role="img" for a11y');
ok(/aria-label/.test(chartSrc), '12f. AdminTrendChart has aria-label for screen readers');

// 12g. Date-range picker has the 6 preset pills + Custom.
const pickerSrc = read('src/lib/components/admin/AdminDateRangePicker.svelte');
ok(/'24h'/.test(pickerSrc) && /'7d'/.test(pickerSrc) && /'30d'/.test(pickerSrc), '12g. date-range picker has 24h/7d/30d presets');
ok(/'3m'/.test(pickerSrc) && /'6m'/.test(pickerSrc) && /'1y'/.test(pickerSrc), '12h. date-range picker has 3m/6m/1y presets');
ok(/custom/.test(pickerSrc), '12i. date-range picker has Custom option');
ok(/type="date"/.test(pickerSrc), '12j. date-range picker uses native date inputs for custom range');

// ============================================================
// 13. Authorization — requireAdmin is the gate
// ============================================================

const adminAuth = read('src/lib/server/streaming/admin-auth.ts');
ok(/export async function requireAdmin/.test(adminAuth), '13a. requireAdmin is exported');
ok(/role !== 'admin'/.test(adminAuth), '13b. requireAdmin checks profiles.role === admin');

// ============================================================
// 14. Zero-data + error-state handling
// ============================================================

// 14a. The overview page has an explicit error state.
ok(/overview-error/.test(overviewPage) && /role="alert"/.test(overviewPage), '14a. overview page has an error state with role="alert"');
// 14b. The overview page has an explicit empty state.
ok(/AdminEmptyState/.test(overviewPage), '14b. overview page uses AdminEmptyState for zero-data');
// 14c. The error state does not expose SQL internals.
ok(!/relation "public/.test(overviewPage), '14c. overview page does not expose raw SQL error text');
ok(!/PGST/.test(overviewPage), '14d. overview page does not expose PostgREST error codes');

// ============================================================
// 15. No double-counting — unique-identity deduplication
// ============================================================

// 15a. The overview module uses Set-based deduplication for unique counts.
ok(/new Set<string>/.test(overviewModule), '15a. overview module uses Set<string> for unique-identity deduplication');
// 15b. Active-users query filters on meaningful events + non-null user_id.
ok(/not\('user_id', 'is', null\)/.test(overviewModule), '15b. active-users query excludes null user_id');
ok(/in\('event_name', MEANINGFUL_EVENTS_ARRAY\)/.test(overviewModule), '15c. active-users query filters on meaningful events');
// 15d. Guest reach uses anonymous_id (not IP).
ok(/anonymous_id/.test(overviewModule), '15d. overview module uses anonymous_id (not IP) for guest identity');
ok(!/ip_hash/.test(overviewModule.replace(/\/\/.*$/gm, '')), '15e. overview module does NOT use ip_hash for identity');

console.log(`phase2_overview_dashboard_test: ${passed} checks passed (date-range math + admin nav + overview route + metrics + funnel + a11y)`);
