<script lang="ts">
  /**
   * Phase 6 — Retention & Cohorts page.
   *
   * Displays cohort retention tables (D1/D7/D30), summary metrics,
   * and behavioral cohort counts. URL-driven date range + cohort type.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
  import AdminMetricCard from '$lib/components/admin/AdminMetricCard.svelte';
  import AdminEmptyState from '$lib/components/admin/AdminEmptyState.svelte';
  import AdminDateRangePicker from '$lib/components/admin/AdminDateRangePicker.svelte';
  import { AlertTriangle, Repeat, Users, TrendingUp } from 'lucide-svelte';
  import { formatUtcDate } from '$lib/shared/analytics-period';
  import type { PageData } from './$types';
  import type { CohortType } from '$lib/server/analytics/retention';

  let { data }: { data: PageData } = $props();

  function onSelectRange(next: { preset: string; from?: string; to?: string }) {
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
    const search = params.toString();
    goto(`${page.url.pathname}${search ? `?${search}` : ''}`, { keepFocus: true, noScroll: true });
  }

  function onSelectCohort(cohort: CohortType) {
    const params = new URLSearchParams(page.url.searchParams);
    params.set('cohort', cohort);
    const search = params.toString();
    goto(`${page.url.pathname}${search ? `?${search}` : ''}`, { keepFocus: true, noScroll: true });
  }

  const hasError = $derived(Boolean(data.result.error));
  const isEmpty = $derived(!hasError && data.result.cohorts.length === 0);

  function formatRate(rate: number | null): string {
    if (rate === null) return '—';
    return `${rate}%`;
  }

  function formatRetained(retained: number | null): string {
    if (retained === null) return '—';
    return retained.toLocaleString();
  }
</script>

<svelte:head>
  <title>Retention — User Management — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminShell active="users-retention">
  <AdminPageHeader
    eyebrow="MAVERO / User Management"
    title="Retention"
    accent="& cohorts."
    description="User return behavior and cohort retention across the selected period."
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

  {#if hasError}
    <div class="retention-error" role="alert">
      <span class="error-icon" aria-hidden="true"><AlertTriangle size={22} /></span>
      <div class="error-copy">
        <h2>Analytics unavailable</h2>
        <p>{data.result.error}</p>
      </div>
    </div>
  {:else if isEmpty}
    <AdminEmptyState
      icon={Repeat}
      title="No cohort data for this period"
      message="No users match the selected cohort type and date range. Try a wider range or a different cohort type."
    />
  {:else}
    <!-- ============================================================
         COHORT TYPE SELECTOR
         ============================================================ -->
    <div class="cohort-selector" role="group" aria-label="Retention cohort type">
      <span class="selector-label">Cohort:</span>
      {#each data.cohortOptions as opt}
        <button
          type="button"
          class="cohort-pill"
          class:active={data.cohortType === opt.id}
          onclick={() => onSelectCohort(opt.id as CohortType)}
          aria-pressed={data.cohortType === opt.id}
        >{opt.label}</button>
      {/each}
    </div>

    <!-- ============================================================
         SUMMARY METRICS
         ============================================================ -->
    <section class="metric-section" aria-label="Retention summary">
      <h2 class="section-heading">Summary — {data.cohortType === 'signup' ? 'Signup' : data.cohortType === 'first-use' ? 'First Use' : 'First Watch'} Cohort</h2>
      <div class="metric-grid">
        <AdminMetricCard
          label="Cohort Users"
          value={data.result.summary.totalCohortUsers.toLocaleString()}
          status="users in the selected period"
          statusTone="info"
          icon={Users}
        />
        <AdminMetricCard
          label="D1 Retention"
          value={formatRate(data.result.summary.d1Rate)}
          status={data.result.summary.d1Rate === null ? 'no eligible cohorts' : 'Day 1 return rate'}
          statusTone={data.result.summary.d1Rate === null ? 'neutral' : 'good'}
          icon={TrendingUp}
        />
        <AdminMetricCard
          label="D7 Retention"
          value={formatRate(data.result.summary.d7Rate)}
          status={data.result.summary.d7Rate === null ? 'no eligible cohorts' : 'Day 7 return rate'}
          statusTone={data.result.summary.d7Rate === null ? 'neutral' : 'good'}
          icon={TrendingUp}
        />
        <AdminMetricCard
          label="D30 Retention"
          value={formatRate(data.result.summary.d30Rate)}
          status={data.result.summary.d30Rate === null ? 'no eligible cohorts' : 'Day 30 return rate'}
          statusTone={data.result.summary.d30Rate === null ? 'neutral' : 'good'}
          icon={TrendingUp}
        />
      </div>
    </section>

    <!-- ============================================================
         COHORT TABLE
         ============================================================ -->
    <section class="metric-section" aria-label="Cohort table">
      <h2 class="section-heading">Cohort Table</h2>
      <div class="table-wrapper" role="region" aria-label="Retention cohort table">
        <table class="cohort-table">
          <thead>
            <tr>
              <th scope="col">Cohort Date</th>
              <th scope="col" class="num-col">Size</th>
              <th scope="col" class="num-col">D1 Retained</th>
              <th scope="col" class="num-col">D1 %</th>
              <th scope="col" class="num-col">D7 Retained</th>
              <th scope="col" class="num-col">D7 %</th>
              <th scope="col" class="num-col">D30 Retained</th>
              <th scope="col" class="num-col">D30 %</th>
            </tr>
          </thead>
          <tbody>
            {#each data.result.cohorts as row (row.cohortDate)}
              <tr>
                <td>{formatUtcDate(row.cohortDate + 'T00:00:00.000Z')}</td>
                <td class="num-col">{row.cohortSize.toLocaleString()}</td>
                <td class="num-col">{formatRetained(row.d1Retained)}</td>
                <td class="num-col">{formatRate(row.d1Rate)}</td>
                <td class="num-col">{formatRetained(row.d7Retained)}</td>
                <td class="num-col">{formatRate(row.d7Rate)}</td>
                <td class="num-col">{formatRetained(row.d30Retained)}</td>
                <td class="num-col">{formatRate(row.d30Rate)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="table-note">
        — = Not yet eligible (the retention window has not elapsed). 0% = eligible cohort with zero returns.
        Calendar-day UTC model: D1 = activity on cohort date + 1 day.
      </p>
    </section>

    <!-- ============================================================
         BEHAVIORAL COHORTS
         ============================================================ -->
    <section class="metric-section" aria-label="Behavioral cohorts">
      <h2 class="section-heading">Behavioral Cohorts</h2>
      <p class="section-desc">Overlapping — a user can appear in multiple cohorts.</p>
      <div class="behavioral-grid">
        {#each data.result.behavioralCohorts as cohort (cohort.id)}
          <div class="behavioral-card">
            <h3 class="behavioral-label">{cohort.label}</h3>
            <strong class="behavioral-count">{cohort.userCount.toLocaleString()}</strong>
            <span class="behavioral-desc">{cohort.description}</span>
          </div>
        {/each}
      </div>
    </section>

    <p class="range-meta">
      Range: {formatUtcDate(data.range.start)} → {formatUtcDate(data.range.end)} (UTC).
      Cohort type: {data.cohortType}. Authenticated users only (user_id).
      Guest retention not available (anonymous_id unreliable for multi-day retention).
    </p>
  {/if}
</AdminShell>

<style>
  .cohort-selector {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 24px;
    flex-wrap: wrap;
  }
  .selector-label {
    color: var(--color-text-deep);
    font-size: .56rem;
    font-weight: 800;
    letter-spacing: .14em;
    text-transform: uppercase;
  }
  .cohort-pill {
    min-height: 32px;
    padding: 0 14px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-surface);
    color: var(--color-text-muted);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .62rem;
    font-weight: 600;
    letter-spacing: .04em;
    text-transform: uppercase;
    cursor: pointer;
    transition: border-color var(--motion-fast) var(--ease-out),
                background var(--motion-fast) var(--ease-out),
                color var(--motion-fast) var(--ease-out);
  }
  .cohort-pill:hover { border-color: var(--color-primary-border); color: var(--color-text); }
  .cohort-pill.active {
    border-color: var(--color-primary-border);
    background: var(--color-primary-soft);
    color: var(--color-primary);
  }
  .cohort-pill:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  .metric-section { margin-top: 28px; }
  .section-heading {
    margin: 0 0 12px;
    color: var(--color-text);
    font-size: .78rem;
    font-weight: 800;
    letter-spacing: .04em;
    text-transform: uppercase;
  }
  .section-desc {
    margin: -6px 0 10px;
    color: var(--color-text-deep);
    font-size: .58rem;
    letter-spacing: .04em;
  }
  .metric-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
  }

  .table-wrapper {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    overflow-x: auto;
  }
  .cohort-table {
    width: 100%;
    border-collapse: collapse;
    font-size: .72rem;
  }
  .cohort-table thead { border-bottom: 1px solid var(--color-border-strong); }
  .cohort-table th {
    padding: 10px 14px;
    text-align: left;
    color: var(--color-text-deep);
    font-size: .56rem;
    font-weight: 800;
    letter-spacing: .12em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .cohort-table td {
    padding: 10px 14px;
    border-top: 1px solid var(--color-border);
    color: var(--color-text-muted);
    white-space: nowrap;
  }
  .num-col {
    text-align: right;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }
  .table-note {
    margin-top: 10px;
    color: var(--color-text-deep);
    font-size: .58rem;
    font-style: italic;
  }

  .behavioral-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
  }
  .behavioral-card {
    padding: 14px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    text-align: center;
  }
  .behavioral-label {
    margin: 0 0 6px;
    color: var(--color-text);
    font-size: .72rem;
    font-weight: 700;
  }
  .behavioral-count {
    display: block;
    color: var(--color-primary);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 1.6rem;
    font-weight: 900;
    line-height: 1.2;
  }
  .behavioral-desc {
    display: block;
    margin-top: 4px;
    color: var(--color-text-deep);
    font-size: .56rem;
    letter-spacing: .02em;
  }

  .range-meta {
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid var(--color-border);
    color: var(--color-text-deep);
    font-size: .58rem;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    letter-spacing: .02em;
  }

  .retention-error {
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
  .error-copy h2 { margin: 0 0 4px; color: var(--color-text); font-size: .9rem; font-weight: 800; }
  .error-copy p { margin: 0; color: var(--color-text-muted); font-size: .74rem; line-height: 1.55; }

  @media (max-width: 1024px) {
    .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .behavioral-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 640px) {
    .metric-grid, .behavioral-grid { grid-template-columns: 1fr; }
  }
</style>
