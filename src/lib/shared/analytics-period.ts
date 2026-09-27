/**
 * Phase 2 — shared analytics date-range utility.
 *
 * Single source of truth for the period presets and the canonical
 * date-range interpretation used by every analytics dashboard page.
 * Later phases (Viewing, Providers, Retention) MUST reuse this module
 * so all dashboards share one timezone and one boundary convention.
 *
 * CONVENTIONS (per plan §24 — Timezone Correctness):
 *   - All ranges are expressed in UTC. The admin dashboard needs a
 *     consistent analytics timezone; UTC is the same convention the
 *     Phase 1 schema uses (`timestamptz not null default now()` and
 *     `event_time timestamptz`). Storage is UTC; the dashboard does
 *     NOT reinterpret boundaries in the operator's local timezone.
 *   - Ranges are HALF-OPEN: [start, end). `start` is inclusive, `end`
 *     is exclusive. This avoids double-counting at boundaries and
 *     makes "Last 7 Days" exactly 7×24h, not 7×24h+1ms.
 *   - `end` is always `now` (the instant the dashboard loads) for
 *     preset ranges; `start` is `end - duration`. Custom ranges use
 *     the operator-supplied `from`/`to` dates (start-of-day for
 *     `from`, end-of-day for `to` — both in UTC).
 *   - "Last 24 Hours" is a 24-hour window (not "today").
 *   - "Last 7 Days" is a 7×24h = 168h window (not "this week").
 *   - "Last 30 Days" is a 30×24h = 720h window (not "this month").
 *   - "Last 3 Months" = 90×24h. "Last 6 Months" = 180×24h.
 *   - "Last 1 Year" = 365×24h.
 *
 * These are DELIBERATE fixed-duration windows (not calendar-window
 * presets like "this month"). Fixed-duration windows make DAU/WAU/MAU
 * math consistent and avoid the "Feb has 28 days" edge cases.
 */

export const ANALYTICS_PERIOD_PRESETS = [
  '24h',
  '7d',
  '30d',
  '3m',
  '6m',
  '1y',
  'custom',
] as const;

export type AnalyticsPeriodPreset = (typeof ANALYTICS_PERIOD_PRESETS)[number];

/** A resolved UTC date range. `end` is exclusive (half-open [start, end)). */
export type AnalyticsDateRange = {
  /** Inclusive start, UTC ISO 8601 string. */
  start: string;
  /** Exclusive end, UTC ISO 8601 string. */
  end: string;
  /** The preset that produced this range, or 'custom'. */
  preset: AnalyticsPeriodPreset;
};

/** Duration in milliseconds for each fixed-duration preset. */
const PRESET_DURATIONS_MS: Record<Exclude<AnalyticsPeriodPreset, 'custom'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '3m': 90 * 24 * 60 * 60 * 1000,
  '6m': 180 * 24 * 60 * 60 * 1000,
  '1y': 365 * 24 * 60 * 60 * 1000,
};

/** Human-readable labels for the preset selector. */
export const ANALYTICS_PERIOD_LABELS: Record<AnalyticsPeriodPreset, string> = {
  '24h': 'Last 24 Hours',
  '7d': 'Last 7 Days',
  '30d': 'Last 30 Days',
  '3m': 'Last 3 Months',
  '6m': 'Last 6 Months',
  '1y': 'Last 1 Year',
  custom: 'Custom',
};

/**
 * Returns true if the value is a known analytics period preset.
 */
export function isAnalyticsPeriodPreset(value: unknown): value is AnalyticsPeriodPreset {
  return typeof value === 'string' && (ANALYTICS_PERIOD_PRESETS as readonly string[]).includes(value);
}

/**
 * Resolves a preset to a UTC date range anchored at `now` (default: the
 * current instant). Returns a half-open range [start, end) where
 * `end = now` and `start = end - duration`.
 *
 * For 'custom', call `resolveCustomRange` instead.
 */
export function resolvePresetRange(
  preset: Exclude<AnalyticsPeriodPreset, 'custom'>,
  now: Date = new Date()
): AnalyticsDateRange {
  const durationMs = PRESET_DURATIONS_MS[preset];
  const endMs = now.getTime();
  const startMs = endMs - durationMs;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    preset,
  };
}

/**
 * Resolves a custom date range. `from` and `to` are date strings in
 * 'YYYY-MM-DD' format (the HTML <input type="date"> wire format).
 *
 * Convention:
 *   - `from` is interpreted as start-of-day UTC (00:00:00.000Z).
 *   - `to` is interpreted as end-of-day UTC (23:59:59.999Z). This makes
 *     the custom range inclusive on both ends (the operator picks two
 *     calendar days and gets the full span of both).
 *   - If `to` is after today, it is clamped to today (no future data).
 *   - If `from` is after `to`, the range is invalid (returns null).
 *   - If `from` is more than 2 years in the past, it is clamped to
 *     2 years ago (bounded query window — the Phase 1 indexes are
 *     sized for this).
 */
export function resolveCustomRange(
  from: string,
  to: string,
  now: Date = new Date()
): AnalyticsDateRange | null {
  // Parse 'YYYY-MM-DD' as a UTC calendar date (NOT local time).
  // `new Date('2026-01-15')` is already parsed as UTC midnight in ES2015+.
  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T23:59:59.999Z`);
  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) return null;
  if (fromDate.getTime() > toDate.getTime()) return null;
  // Clamp `to` to now (no future data).
  const endMs = Math.min(toDate.getTime(), now.getTime());
  // Clamp `from` to 2 years ago (bounded query window).
  const twoYearsAgoMs = now.getTime() - 2 * 365 * 24 * 60 * 60 * 1000;
  const startMs = Math.max(fromDate.getTime(), twoYearsAgoMs);
  // Phase 7 fix: after clamping, if start > end (e.g. both from and to
  // were in the future, so `to` was clamped to now but `from` was not),
  // return null to prevent a negative range that silently produces an
  // empty dashboard.
  if (startMs > endMs) return null;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    preset: 'custom',
  };
}

/**
 * Resolves a date range from URL search params. Accepts either:
 *   - `?period=7d` (a preset), OR
 *   - `?period=custom&from=2026-01-01&to=2026-01-31` (a custom range).
 *
 * Falls back to `defaultPreset` (default '30d') when the params are
 * absent or invalid. This is the canonical entry point for admin
 * dashboard server load functions.
 */
export function resolveRangeFromParams(
  params: URLSearchParams,
  defaultPreset: Exclude<AnalyticsPeriodPreset, 'custom'> = '30d'
): { range: AnalyticsDateRange; preset: AnalyticsPeriodPreset; from?: string; to?: string } {
  const rawPeriod = params.get('period');
  if (rawPeriod && isAnalyticsPeriodPreset(rawPeriod) && rawPeriod !== 'custom') {
    return { range: resolvePresetRange(rawPeriod), preset: rawPeriod };
  }
  if (rawPeriod === 'custom') {
    const from = params.get('from') ?? undefined;
    const to = params.get('to') ?? undefined;
    if (from && to) {
      const custom = resolveCustomRange(from, to);
      if (custom) return { range: custom, preset: 'custom', from, to };
    }
    // Invalid custom range — fall through to default.
  }
  return { range: resolvePresetRange(defaultPreset), preset: defaultPreset };
}

/**
 * Returns the number of days between two ISO date strings (inclusive of
 * the start day). Used to choose chart granularity (daily vs weekly).
 */
export function rangeDays(range: AnalyticsDateRange): number {
  const ms = new Date(range.end).getTime() - new Date(range.start).getTime();
  return Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

/**
 * Returns the recommended chart granularity for a range:
 *   - ≤ 60 days  → 'day'   (one point per day)
 *   - ≤ 180 days → 'week'  (one point per ISO week)
 *   - > 180 days → 'month' (one point per calendar month)
 *
 * This keeps the chart readable (no thousands of raw points).
 */
export function chartGranularity(range: AnalyticsDateRange): 'day' | 'week' | 'month' {
  const days = rangeDays(range);
  if (days <= 60) return 'day';
  if (days <= 180) return 'week';
  return 'month';
}

/**
 * Returns an array of bucket boundaries (UTC ISO strings) for the
 * range, suitable for grouping analytics_events into time-series
 * points. Each bucket is half-open [bucketStart, bucketEnd).
 *
 * For 'day' granularity, buckets are calendar days in UTC.
 * For 'week' granularity, buckets start on Monday 00:00 UTC.
 * For 'month' granularity, buckets are calendar months in UTC.
 */
export function rangeBuckets(range: AnalyticsDateRange): Array<{ start: string; end: string; label: string }> {
  const granularity = chartGranularity(range);
  const buckets: Array<{ start: string; end: string; label: string }> = [];
  const startMs = new Date(range.start).getTime();
  const endMs = new Date(range.end).getTime();
  if (granularity === 'day') {
    // Align to start-of-day UTC.
    const cursor = new Date(startMs);
    cursor.setUTCHours(0, 0, 0, 0);
    while (cursor.getTime() < endMs) {
      const bucketStart = new Date(cursor);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      const bucketEnd = new Date(cursor);
      buckets.push({
        start: bucketStart.toISOString(),
        end: bucketEnd.toISOString(),
        label: bucketStart.toISOString().slice(0, 10), // YYYY-MM-DD
      });
    }
  } else if (granularity === 'week') {
    // Align to Monday 00:00 UTC.
    const cursor = new Date(startMs);
    cursor.setUTCHours(0, 0, 0, 0);
    // Move back to the most recent Monday.
    const dayOfWeek = cursor.getUTCDay(); // 0=Sunday, 1=Monday, ...
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    cursor.setUTCDate(cursor.getUTCDate() - daysSinceMonday);
    while (cursor.getTime() < endMs) {
      const bucketStart = new Date(cursor);
      cursor.setUTCDate(cursor.getUTCDate() + 7);
      const bucketEnd = new Date(cursor);
      buckets.push({
        start: bucketStart.toISOString(),
        end: bucketEnd.toISOString(),
        label: bucketStart.toISOString().slice(0, 10),
      });
    }
  } else {
    // Month granularity — align to start-of-month UTC.
    const cursor = new Date(startMs);
    cursor.setUTCHours(0, 0, 0, 0);
    cursor.setUTCDate(1);
    while (cursor.getTime() < endMs) {
      const bucketStart = new Date(cursor);
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      const bucketEnd = new Date(cursor);
      buckets.push({
        start: bucketStart.toISOString(),
        end: bucketEnd.toISOString(),
        label: bucketStart.toISOString().slice(0, 7), // YYYY-MM
      });
    }
  }
  return buckets;
}

/**
 * Formats a UTC ISO string for display in the admin UI.
 * Returns a short, human-readable date (e.g. "Sep 26, 2026").
 */
export function formatUtcDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Formats a UTC ISO string with time for display.
 * Returns e.g. "Sep 26, 2026, 14:30 UTC".
 */
export function formatUtcDateTime(iso: string): string {
  const d = new Date(iso);
  const datePart = d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const timePart = d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
  return `${datePart}, ${timePart} UTC`;
}
