<script lang="ts">
  /**
   * Phase 2 — User Management → Overview dashboard.
   *
   * Displays reach + engagement metrics computed from the Phase 1
   * analytics_events / analytics_sessions tables. All data is
   * server-fetched (no client-side aggregation). The page re-navigates
   * on date-range / trend-mode changes so the URL is the single source
   * of truth (shareable, bookmarkable, back-button friendly).
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
  import AdminMetricCard from '$lib/components/admin/AdminMetricCard.svelte';
  import AdminEmptyState from '$lib/components/admin/AdminEmptyState.svelte';
  import AdminDateRangePicker from '$lib/components/admin/AdminDateRangePicker.svelte';
  import AdminTrendChart from '$lib/components/admin/AdminTrendChart.svelte';
  import AdminFunnel from '$lib/components/admin/AdminFunnel.svelte';
  import { AlertTriangle, Activity, Users, UserPlus, RefreshCw, Globe, ShieldCheck, TrendingUp } from 'lucide-svelte';
  import { formatUtcDate } from '$lib/shared/analytics-period';
  import type { PageData } from './$types';
  import type { TrendMode, TrendMetric } from '$lib/server/analytics/overview';

  let { data }: { data: PageData } = $props();

  // The current URL search params are the source of truth for the
  // date-range / trend-mode state. Navigation replaces the URL so the
  // back button works.
  function navigate(next: { preset?: string; from?: string; to?: string; mode?: TrendMode; metric?: TrendMetric }) {
    const params = new URLSearchParams(page.url.searchParams);
    if (next.preset) {
      params.set('period', next.preset);
      if (next.preset !== 'custom') {
        params.delete('from');
        params.delete('to');
      } else {
        if (next.from) params.set('from', next.from);
        if (next.to) params.set('to', next.to);
      }
    }
    if (next.mode) params.set('mode', next.mode);
    if (next.metric) params.set('metric', next.metric);
    const search = params.toString();
    goto(`${page.url.pathname}${search ? `?${search}` : ''}`, { keepFocus: true, noScroll: true });
  }

  function onSelectRange(next: { preset: string; from?: string; to?: string }) {
    navigate(next);
  }

  function onSelectMode(mode: TrendMode) {
    navigate({ mode });
  }

  function onSelectMetric(metric: TrendMetric) {
    navigate({ metric });
  }

  // Whether to show the error state (migration pending or query failed).
  const hasError = $derived(Boolean(data.overview.error));
  const migrationPending = $derived(data.overview.migrationPending);

  // Whether to show the empty state (no error, but all metrics are zero).
  const isEmpty = $derived(
    !hasError &&
    data.overview.metrics.totalUsers === 0 &&
    data.overview.metrics.activeUsers === 0 &&
    data.overview.metrics.guestReach === 0 &&
    data.overview.metrics.loggedInReach === 0
  );

  // Trend mode + metric options.
  const modeOptions: Array<{ id: TrendMode; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'guest', label: 'Guest' },
    { id: 'logged-in', label: 'Logged-in' },
    { id: 'new', label: 'New' },
    { id: 'returning', label: 'Returning' },
  ];
  const metricOptions: Array<{ id: TrendMetric; label: string }> = [
    { id: 'users', label: 'Users' },
    { id: 'sessions', label: 'Sessions' },
    { id: 'watch-starts', label: 'Watch Starts' },
  ];
</script>

<svelte:head>
  <title>User Management — Overview — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminShell active="users-overview">
  <AdminPageHeader
    eyebrow="MAVERO / User Management"
    title="Overview"
    accent="dashboard."
    description="Reach, engagement, and guest-to-account conversion across the selected period."
  >
    {#snippet actions()}
      <AdminDateRangePicker
        preset={data.preset}
        from={data.from ?? ''}
        to={data.to ?? ''}
        onSelect={onSelectRange}
      />
    {/snippet}
  </AdminPageHeader>

  <!-- ============================================================
       ERROR STATE — analytics queries failed (migration not applied
       or transient DB error). Shows a clear admin-facing message
       without exposing SQL internals or credentials.
       ============================================================ -->
  {#if hasError}
    <div class="overview-error" role="alert">
      <span class="error-icon" aria-hidden="true"><AlertTriangle size={22} /></span>
      <div class="error-copy">
        <h2>Analytics unavailable</h2>
        <p>{data.overview.error}</p>
        {#if migrationPending}
          <p class="error-hint">
            Apply <code>supabase/migrations/20261008000000_analytics_foundation.sql</code>
            via the Supabase SQL Editor, then reload this page.
            See <code>docs/supabase-migration-runbook.md</code> for details.
          </p>
        {/if}
      </div>
    </div>
  {:else if isEmpty}
    <!-- ============================================================
         EMPTY STATE — no analytics data for the selected period.
         ============================================================ -->
    <AdminEmptyState
      icon={Activity}
      title="No activity recorded for this period"
      message="The selected date range has no analytics events. Try a wider range, or wait for users to generate activity."
    />
  {:else}
    <!-- ============================================================
         TOP METRIC CARDS — Total / Active / New / Returning
         ============================================================ -->
    <section class="metric-section" aria-label="User summary">
      <h2 class="section-heading">Users</h2>
      <div class="metric-grid">
        <AdminMetricCard
          label="Total Users"
          value={data.overview.metrics.totalUsers.toLocaleString()}
          status="registered accounts"
          statusTone="info"
          icon={Users}
        />
        <AdminMetricCard
          label="Active Users"
          value={data.overview.metrics.activeUsers.toLocaleString()}
          status="meaningful activity"
          statusTone="good"
          icon={Activity}
        />
        <AdminMetricCard
          label="New Users"
          value={data.overview.metrics.newUsers.toLocaleString()}
          status="joined this period"
          statusTone="info"
          icon={UserPlus}
        />
        <AdminMetricCard
          label="Returning Users"
          value={data.overview.metrics.returningUsers.toLocaleString()}
          status="active before this period"
          statusTone="info"
          icon={RefreshCw}
        />
      </div>
    </section>

    <!-- ============================================================
         GUEST VS LOGGED-IN — Reach + Active breakdown
         ============================================================ -->
    <section class="metric-section" aria-label="Guest vs logged-in">
      <h2 class="section-heading">Guest vs Logged-in</h2>
      <div class="metric-grid two-col">
        <div class="metric-subgroup">
          <h3 class="subgroup-heading">Guest</h3>
          <div class="metric-grid two-col nested">
            <AdminMetricCard
              label="Guest Reach"
              value={data.overview.metrics.guestReach.toLocaleString()}
              status="unique anonymous identities"
              statusTone="neutral"
              icon={Globe}
            />
            <AdminMetricCard
              label="Guest Active"
              value={data.overview.metrics.guestActive.toLocaleString()}
              status="meaningful activity"
              statusTone="good"
              icon={Activity}
            />
          </div>
        </div>
        <div class="metric-subgroup">
          <h3 class="subgroup-heading">Logged-in</h3>
          <div class="metric-grid two-col nested">
            <AdminMetricCard
              label="Logged-in Reach"
              value={data.overview.metrics.loggedInReach.toLocaleString()}
              status="unique authenticated users"
              statusTone="info"
              icon={ShieldCheck}
            />
            <AdminMetricCard
              label="Logged-in Active"
              value={data.overview.metrics.loggedInActive.toLocaleString()}
              status="meaningful activity"
              statusTone="good"
              icon={Activity}
            />
          </div>
        </div>
      </div>

      <!-- New / Returning breakdown (where supported by the Phase 1 model). -->
      <div class="metric-grid two-col">
        <div class="metric-subgroup">
          <h3 class="subgroup-heading">New</h3>
          <div class="metric-grid two-col nested">
            <AdminMetricCard
              label="Guest New"
              value={data.overview.metrics.guestNew === null ? '—' : data.overview.metrics.guestNew.toLocaleString()}
              status={data.overview.metrics.guestNew === null ? 'not computed' : 'first seen this period'}
              statusTone={data.overview.metrics.guestNew === null ? 'neutral' : 'info'}
              icon={UserPlus}
            />
            <AdminMetricCard
              label="Logged-in New"
              value={data.overview.metrics.loggedInNew.toLocaleString()}
              status="joined this period"
              statusTone="info"
              icon={UserPlus}
            />
          </div>
        </div>
        <div class="metric-subgroup">
          <h3 class="subgroup-heading">Returning</h3>
          <div class="metric-grid two-col nested">
            <AdminMetricCard
              label="Guest Returning"
              value={data.overview.metrics.guestReturning === null ? '—' : data.overview.metrics.guestReturning.toLocaleString()}
              status={data.overview.metrics.guestReturning === null ? 'not computed' : 'seen before this period'}
              statusTone={data.overview.metrics.guestReturning === null ? 'neutral' : 'info'}
              icon={RefreshCw}
            />
            <AdminMetricCard
              label="Logged-in Returning"
              value={data.overview.metrics.loggedInReturning.toLocaleString()}
              status="active before this period"
              statusTone="info"
              icon={RefreshCw}
            />
          </div>
        </div>
      </div>
    </section>

    <!-- ============================================================
         DAU / WAU / MAU + Stickiness
         ============================================================ -->
    <section class="metric-section" aria-label="DAU WAU MAU">
      <h2 class="section-heading">Engagement Windows</h2>
      <div class="metric-grid four-col">
        <AdminMetricCard
          label="DAU"
          value={data.overview.metrics.dau.toLocaleString()}
          status="last 24h active"
          statusTone="good"
          icon={Activity}
        />
        <AdminMetricCard
          label="WAU"
          value={data.overview.metrics.wau.toLocaleString()}
          status="last 7d active"
          statusTone="info"
          icon={TrendingUp}
        />
        <AdminMetricCard
          label="MAU"
          value={data.overview.metrics.mau.toLocaleString()}
          status="last 30d active"
          statusTone="info"
          icon={TrendingUp}
        />
        <AdminMetricCard
          label="DAU / MAU"
          value={data.overview.metrics.dauMauRatio === null ? '—' : `${data.overview.metrics.dauMauRatio}%`}
          status={data.overview.metrics.dauMauRatio === null ? 'MAU is zero' : 'stickiness'}
          statusTone={data.overview.metrics.dauMauRatio === null ? 'neutral' : 'good'}
          icon={Activity}
        />
      </div>
    </section>

    <!-- ============================================================
         REACH TREND GRAPH — with mode + metric toggles
         ============================================================ -->
    <section class="metric-section" aria-label="Reach trend">
      <div class="section-head">
        <h2 class="section-heading">Reach Trend</h2>
        <div class="trend-controls">
          <div class="toggle-group" role="group" aria-label="Trend mode">
            {#each modeOptions as opt}
              <button
                type="button"
                class="toggle-pill"
                class:active={data.trendMode === opt.id}
                onclick={() => onSelectMode(opt.id)}
                aria-pressed={data.trendMode === opt.id}
              >{opt.label}</button>
            {/each}
          </div>
          <div class="toggle-group" role="group" aria-label="Trend metric">
            {#each metricOptions as opt}
              <button
                type="button"
                class="toggle-pill"
                class:active={data.trendMetric === opt.id}
                onclick={() => onSelectMetric(opt.id)}
                aria-pressed={data.trendMetric === opt.id}
              >{opt.label}</button>
            {/each}
          </div>
        </div>
      </div>
      <div class="chart-card">
        <AdminTrendChart
          points={data.overview.trend.points}
          label={`${data.trendMode} ${data.trendMetric}`}
          emptyMessage="No trend data for this period."
        />
        <p class="chart-meta">
          Granularity: {data.overview.trend.granularity}.
          {data.overview.trend.points.length} points.
          Range: {formatUtcDate(data.range.start)} → {formatUtcDate(data.range.end)} (UTC).
        </p>
      </div>
    </section>

    <!-- ============================================================
         GUEST → ACCOUNT CONVERSION FUNNEL
         ============================================================ -->
    <section class="metric-section" aria-label="Guest to account funnel">
      <h2 class="section-heading">Guest → Account Conversion</h2>
      <div class="funnel-card">
        <AdminFunnel
          funnel={data.overview.funnel}
          emptyMessage="No guest activity recorded for this period."
        />
      </div>
    </section>
  {/if}
</AdminShell>

<style>
  .metric-section {
    margin-top: 28px;
  }
  .section-heading {
    margin: 0 0 12px;
    color: var(--color-text);
    font-size: .78rem;
    font-weight: 800;
    letter-spacing: .04em;
    text-transform: uppercase;
  }
  .section-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .section-head .section-heading {
    margin: 0;
  }
  .metric-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
  }
  .metric-grid.two-col {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .metric-grid.four-col {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
  .metric-grid.nested {
    margin-top: 8px;
  }
  .metric-subgroup {
    padding: 14px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }
  .subgroup-heading {
    margin: 0 0 8px;
    color: var(--color-text-deep);
    font-size: .56rem;
    font-weight: 800;
    letter-spacing: .14em;
    text-transform: uppercase;
  }
  .trend-controls {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .toggle-group {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-surface);
  }
  .toggle-pill {
    min-height: 28px;
    padding: 0 12px;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: var(--color-text-muted);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .6rem;
    font-weight: 600;
    letter-spacing: .04em;
    text-transform: uppercase;
    cursor: pointer;
    transition: background var(--motion-fast) var(--ease-out),
                color var(--motion-fast) var(--ease-out);
  }
  .toggle-pill:hover {
    color: var(--color-text);
  }
  .toggle-pill.active {
    background: var(--color-primary-soft);
    color: var(--color-primary);
  }
  .toggle-pill:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 1px;
  }
  .chart-card,
  .funnel-card {
    padding: 16px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }
  .chart-meta {
    margin: 12px 0 0;
    color: var(--color-text-deep);
    font-size: .58rem;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    letter-spacing: .02em;
  }
  .overview-error {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    margin-top: 24px;
    padding: 18px;
    border: 1px solid rgba(255, 77, 109, .25);
    border-radius: var(--radius-md);
    background: rgba(255, 77, 109, .07);
  }
  .error-icon {
    display: inline-grid;
    place-items: center;
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border: 1px solid rgba(255, 77, 109, .3);
    border-radius: 50%;
    color: var(--color-danger);
    background: rgba(255, 77, 109, .1);
  }
  .error-copy h2 {
    margin: 0 0 4px;
    color: var(--color-text);
    font-size: .9rem;
    font-weight: 800;
  }
  .error-copy p {
    margin: 0 0 6px;
    color: var(--color-text-muted);
    font-size: .74rem;
    line-height: 1.55;
  }
  .error-copy .error-hint {
    color: var(--color-text-deep);
    font-size: .68rem;
  }
  .error-copy code {
    color: var(--color-primary);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .9em;
  }

  /* Responsive — stack on tablet/mobile. */
  @media (max-width: 1024px) {
    .metric-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .metric-grid.four-col {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 640px) {
    .metric-grid,
    .metric-grid.two-col,
    .metric-grid.four-col,
    .metric-grid.nested {
      grid-template-columns: 1fr;
    }
    .section-head {
      flex-direction: column;
      align-items: stretch;
    }
    .trend-controls {
      flex-direction: column;
      align-items: stretch;
    }
    .toggle-group {
      justify-content: center;
      flex-wrap: wrap;
    }
  }
</style>
