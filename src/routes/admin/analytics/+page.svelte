<script lang="ts">
  /**
   * Admin 2.0 — Phase H — Analytics workspace.
   *
   * Unified workspace with five contextual tabs:
   *   - Overview — KPIs + trends + funnel
   *   - Users — user list with guest/auth separation
   *   - Viewing — top content + watch metrics
   *   - Providers — provider/source usage
   *   - Retention — cohort matrix
   *
   * All metrics come from real analytics_events data — no fabricated numbers.
   * Timezone is UTC throughout (per plan §24 + analytics-period.ts).
   *
   * The page reuses existing analytics services (fetchOverview, listUsers,
   * fetchViewing, fetchProviders, fetchRetention). No new backend APIs.
   *
   * Tab switches navigate to ?tab=<tab> which triggers a server reload
   * with the active tab's data. Period changes also trigger a reload.
   */

  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminStatus from '$lib/components/admin2/AdminStatus.svelte';
  import {
    ANALYTICS_PERIOD_PRESETS,
    ANALYTICS_PERIOD_LABELS,
    formatUtcDate,
    type AnalyticsPeriodPreset,
  } from '$lib/shared/analytics-period';
  import {
    BarChart3, Users, Eye, Server, Repeat, AlertCircle,
    TrendingUp, TrendingDown, Minus, ExternalLink, ChevronLeft, ChevronRight,
  } from 'lucide-svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const VALID_TABS = new Set(['overview', 'users', 'viewing', 'providers', 'retention']);
  // svelte-ignore state_referenced_locally
  let currentTab = $state<string>(VALID_TABS.has(data.initialTab) ? data.initialTab : 'overview');

  $effect(() => {
    const urlTab = page.url.searchParams.get('tab') ?? 'overview';
    if (VALID_TABS.has(urlTab)) {
      currentTab = urlTab;
    }
  });

  function switchTab(tab: string) {
    if (!VALID_TABS.has(tab) || tab === currentTab) return;
    currentTab = tab;
    const params = new URLSearchParams(page.url.searchParams);
    params.set('tab', tab);
    goto(`${page.url.pathname}?${params.toString()}`, { noScroll: true });
  }

  function changePeriod(preset: AnalyticsPeriodPreset) {
    const params = new URLSearchParams(page.url.searchParams);
    params.set('period', preset);
    if (preset !== 'custom') {
      params.delete('from');
      params.delete('to');
    }
    params.delete('page');
    goto(`${page.url.pathname}?${params.toString()}`, { noScroll: true });
  }

  function changeCustomRange() {
    const fromVal = (document.getElementById('a2-analytics-from') as HTMLInputElement)?.value;
    const toVal = (document.getElementById('a2-analytics-to') as HTMLInputElement)?.value;
    if (!fromVal || !toVal) return;
    const params = new URLSearchParams(page.url.searchParams);
    params.set('period', 'custom');
    params.set('from', fromVal);
    params.set('to', toVal);
    params.delete('page');
    goto(`${page.url.pathname}?${params.toString()}`, { noScroll: true });
  }

  // --- Helpers ---
  function formatNumber(n: number | null | undefined): string {
    if (n == null) return '—';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  function formatPercent(n: number | null | undefined): string {
    if (n == null) return '—';
    return `${n.toFixed(1)}%`;
  }

  function formatDuration(seconds: number | null | undefined): string {
    if (seconds == null || seconds === 0) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function comparisonTone(delta: number | null | undefined): 'green' | 'red' | 'neutral' {
    if (delta == null) return 'neutral';
    if (delta > 0) return 'green';
    if (delta < 0) return 'red';
    return 'neutral';
  }

  function comparisonIcon(delta: number | null | undefined) {
    if (delta == null) return Minus;
    if (delta > 0) return TrendingUp;
    if (delta < 0) return TrendingDown;
    return Minus;
  }

  function comparisonLabel(delta: number | null | undefined): string {
    if (delta == null) return 'no comparison';
    const sign = delta > 0 ? '+' : '';
    return `${sign}${delta.toFixed(1)}% vs previous`;
  }

  const tabs = [
    { id: 'overview', label: 'Overview', icon: BarChart3 },
    { id: 'users', label: 'Users', icon: Users },
    { id: 'viewing', label: 'Viewing', icon: Eye },
    { id: 'providers', label: 'Providers', icon: Server },
    { id: 'retention', label: 'Retention', icon: Repeat },
  ];

  // svelte-ignore state_referenced_locally
  let currentPeriod = $state(data.preset);
  $effect(() => { currentPeriod = data.preset; });
</script>

<svelte:head>
  <title>Analytics — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell active="analytics">
  <AdminPage
    eyebrow="People"
    title="Analytics"
    accent="cyan"
    tabs={tabs.map((t) => ({ id: t.id, label: t.label, active: t.id === currentTab, onclick: () => switchTab(t.id) }))}
  >
    {#snippet description()}
      <p>Audience and viewing analytics. All metrics are derived from real analytics events (UTC timezone). No fabricated data.</p>
    {/snippet}

    {#snippet actions()}
      <div class="a2-period-bar">
        <select bind:value={currentPeriod} onchange={(e) => changePeriod(e.currentTarget.value as AnalyticsPeriodPreset)} class="a2-period-select">
          {#each ANALYTICS_PERIOD_PRESETS as p}
            <option value={p}>{ANALYTICS_PERIOD_LABELS[p]}</option>
          {/each}
        </select>
        {#if currentPeriod === 'custom'}
          <input id="a2-analytics-from" type="date" value={data.from ?? ''} onchange={changeCustomRange} class="a2-period-date" />
          <span class="a2-period-sep">→</span>
          <input id="a2-analytics-to" type="date" value={data.to ?? ''} onchange={changeCustomRange} class="a2-period-date" />
        {/if}
        <span class="a2-period-range mono">
          {formatUtcDate(data.range.start)} – {formatUtcDate(data.range.end)}
        </span>
      </div>
    {/snippet}

    <!-- Error state -->
    {#if data.analyticsError}
      <div class="a2-analytics-error" role="alert">
        <AlertCircle size={20} />
        <div>
          <p class="a2-analytics-error-title">Unable to load analytics</p>
          <p class="a2-analytics-error-desc">{data.analyticsError}</p>
        </div>
      </div>
    {:else}
      <!-- Overview tab -->
      {#if currentTab === 'overview' && data.overview}
        {@const o = data.overview}
        {#if o.error}
          <div class="a2-analytics-error" role="alert">
            <AlertCircle size={20} />
            <div>
              <p class="a2-analytics-error-title">Analytics not available</p>
              <p class="a2-analytics-error-desc">{o.error}</p>
            </div>
          </div>
        {:else}
          {@const m = o.metrics}
          <!-- KPI cards -->
          <div class="a2-kpi-grid">
            <div class="a2-kpi-card">
              <span class="a2-kpi-label">Total Users</span>
              <span class="a2-kpi-value">{formatNumber(m.totalUsers)}</span>
              {#if m.totalUsersComparison != null}
                <span class="a2-kpi-comparison" data-tone={comparisonTone(m.totalUsersComparison)}>
                  {#if m.totalUsersComparison > 0}<TrendingUp size={11} />{:else if m.totalUsersComparison < 0}<TrendingDown size={11} />{:else}<Minus size={11} />{/if}
                  {comparisonLabel(m.totalUsersComparison)}
                </span>
              {/if}
            </div>
            <div class="a2-kpi-card">
              <span class="a2-kpi-label">Active Users</span>
              <span class="a2-kpi-value">{formatNumber(m.activeUsers)}</span>
              <span class="a2-kpi-hint">Active = ≥1 meaningful event in period</span>
            </div>
            <div class="a2-kpi-card">
              <span class="a2-kpi-label">New Users</span>
              <span class="a2-kpi-value">{formatNumber(m.newUsers)}</span>
              <span class="a2-kpi-hint">First activity in period</span>
            </div>
            <div class="a2-kpi-card">
              <span class="a2-kpi-label">Returning</span>
              <span class="a2-kpi-value">{formatNumber(m.returningUsers)}</span>
              <span class="a2-kpi-hint">Active before + in period</span>
            </div>
            <div class="a2-kpi-card">
              <span class="a2-kpi-label">Guest Sessions</span>
              <span class="a2-kpi-value">{formatNumber(m.guestReach)}</span>
              <span class="a2-kpi-hint">Unique anonymous IDs</span>
            </div>
            <div class="a2-kpi-card">
              <span class="a2-kpi-label">Watch Starts</span>
              <span class="a2-kpi-value">{formatNumber(m.watchStarts)}</span>
            </div>
          </div>

          <!-- DAU/WAU/MAU -->
          {#if m.dau != null || m.wau != null || m.mau != null}
            <div class="a2-section">
              <h3 class="a2-section-title">Reach (anchored at range end)</h3>
              <div class="a2-reach-grid">
                <div class="a2-reach-card"><span class="a2-reach-label">DAU</span><span class="a2-reach-value">{formatNumber(m.dau)}</span><span class="a2-reach-hint">24h</span></div>
                <div class="a2-reach-card"><span class="a2-reach-label">WAU</span><span class="a2-reach-value">{formatNumber(m.wau)}</span><span class="a2-reach-hint">7d</span></div>
                <div class="a2-reach-card"><span class="a2-reach-label">MAU</span><span class="a2-reach-value">{formatNumber(m.mau)}</span><span class="a2-reach-hint">30d</span></div>
                {#if m.stickiness != null}
                  <div class="a2-reach-card"><span class="a2-reach-label">Stickiness</span><span class="a2-reach-value">{formatPercent(m.stickiness)}</span><span class="a2-reach-hint">DAU/MAU</span></div>
                {/if}
              </div>
            </div>
          {/if}

          <!-- Trend chart (text-based — no chart library dependency) -->
          {#if o.trend && o.trend.points.length > 0}
            <div class="a2-section">
              <h3 class="a2-section-title">Activity Trend ({o.trend.metric}, {o.trend.mode})</h3>
              <div class="a2-trend-chart" role="img" aria-label="Activity trend chart">
                {#each o.trend.points as point}
                  {@const maxVal = Math.max(...o.trend.points.map((p: any) => p.value), 1)}
                  {@const heightPct = maxVal > 0 ? (point.value / maxVal) * 100 : 0}
                  <div class="a2-trend-bar" style="height: {Math.max(2, heightPct)}%" title="{point.label}: {point.value}">
                    <span class="a2-trend-bar-value">{point.value > 0 ? point.value : ''}</span>
                  </div>
                {/each}
              </div>
            </div>
          {:else}
            <div class="a2-empty-inline">No trend data in this period.</div>
          {/if}

          <!-- Funnel -->
          {#if o.funnel && o.funnel.stages.length > 0}
            <div class="a2-section">
              <h3 class="a2-section-title">Guest → Account Conversion Funnel</h3>
              <div class="a2-funnel">
                {#each o.funnel.stages as stage, i}
                  <div class="a2-funnel-stage" style="--stage-pct: {(stage.count / Math.max(o.funnel.stages[0].count, 1)) * 100}%">
                    <span class="a2-funnel-stage-num">{i + 1}</span>
                    <span class="a2-funnel-stage-label">{stage.label}</span>
                    <span class="a2-funnel-stage-count">{formatNumber(stage.count)}</span>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        {/if}

      <!-- Users tab -->
      {:else if currentTab === 'users' && data.users}
        {@const u = data.users}
        {@const totalPages = Math.ceil((u.total ?? 0) / (u.pageSize || 1))}
        {#if u.error}
          <div class="a2-analytics-error" role="alert"><AlertCircle size={20} /><p>{u.error}</p></div>
        {:else if u.users.length === 0}
          <div class="a2-empty"><Users size={32} /><h3>No users found</h3><p>{data.usersQ ? 'Try a different search.' : 'No users match the current filter.'}</p></div>
        {:else}
          <!-- Phase 3 mobile: card list (visible <768px). Whole-card anchor to /admin/users/[id]. -->
          <ul class="a2-analytics-card-list a2-users-card-list" role="list">
            {#each u.users as user (user.id)}
              <li>
                <a class="a2-users-card" href={`/admin/users/${user.id}`}>
                  <div class="a2-users-card-head">
                    <span class="a2-users-role-badge" data-role={user.role}>{user.role}</span>
                    {#if user.is_active}<span class="a2-users-chip a2-users-chip-good">Active</span>{/if}
                    {#if user.is_new}<span class="a2-users-chip">New</span>{/if}
                    {#if user.is_returning}<span class="a2-users-chip">Returning</span>{/if}
                  </div>
                  <div class="a2-users-card-name">{user.display_name || user.email || '—'}</div>
                  {#if user.email && user.display_name}<div class="a2-users-card-email mono">{user.email}</div>{/if}
                  <div class="a2-users-card-foot">
                    <span>Last seen <span class="mono">{user.last_active ? formatUtcDate(user.last_active) : 'never'}</span></span>
                    <span class="a2-users-card-open">Open profile <ExternalLink size={11} /></span>
                  </div>
                </a>
              </li>
            {/each}
          </ul>
          <!-- Desktop table (hidden <768px) -->
          <div class="a2-table-wrap a2-users-wrap">
            <table class="a2-table">
              <thead><tr><th>User</th><th>Role</th><th>Active</th><th>New</th><th>Returning</th><th>Last seen</th><th></th></tr></thead>
              <tbody>
                {#each u.users as user (user.id)}
                  <tr>
                    <td><div class="a2-user-cell"><span class="a2-user-name">{user.display_name || user.email || '—'}</span></div></td>
                    <td>{user.role}</td>
                    <td>{user.is_active ? '✓' : '—'}</td>
                    <td>{user.is_new ? '✓' : '—'}</td>
                    <td>{user.is_returning ? '✓' : '—'}</td>
                    <td class="mono">{user.last_active ? formatUtcDate(user.last_active) : '—'}</td>
                    <td><a href={`/admin/users/${user.id}`} class="a2-row-link"><ExternalLink size={11} /></a></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if totalPages > 1}
            <div class="a2-pagination">
              <button type="button" class="a2-page-btn" onclick={() => goto(`${page.url.pathname}?${new URLSearchParams({ ...Object.fromEntries(page.url.searchParams), tab: 'users', page: String(u.page - 1) }).toString()}`, { noScroll: true })} disabled={u.page <= 1}><ChevronLeft size={12} /> Prev</button>
              <span class="a2-page-info mono">Page {u.page} of {totalPages}</span>
              <button type="button" class="a2-page-btn" onclick={() => goto(`${page.url.pathname}?${new URLSearchParams({ ...Object.fromEntries(page.url.searchParams), tab: 'users', page: String(u.page + 1) }).toString()}`, { noScroll: true })} disabled={u.page >= totalPages}>Next <ChevronRight size={12} /></button>
            </div>
          {/if}
        {/if}

      <!-- Viewing tab -->
      {:else if currentTab === 'viewing' && data.viewing}
        {@const v = data.viewing}
        {#if v.error}
          <div class="a2-analytics-error" role="alert"><AlertCircle size={20} /><p>{v.error}</p></div>
        {:else}
          {@const m = v.metrics}
          <div class="a2-kpi-grid">
            <div class="a2-kpi-card"><span class="a2-kpi-label">Total Views</span><span class="a2-kpi-value">{formatNumber(m.totalViews)}</span></div>
            <div class="a2-kpi-card"><span class="a2-kpi-label">Unique Viewers</span><span class="a2-kpi-value">{formatNumber(m.uniqueViewers)}</span></div>
            <div class="a2-kpi-card"><span class="a2-kpi-label">Watch Starts</span><span class="a2-kpi-value">{formatNumber(m.watchStarts)}</span></div>
            <div class="a2-kpi-card"><span class="a2-kpi-label">Completed</span><span class="a2-kpi-value">{formatNumber(m.watchCompletes)}</span></div>
            <div class="a2-kpi-card"><span class="a2-kpi-label">Watch Time</span><span class="a2-kpi-value">{formatDuration(m.approxWatchTimeSeconds)}</span><span class="a2-kpi-hint">Approximate</span></div>
            <div class="a2-kpi-card"><span class="a2-kpi-label">Searches</span><span class="a2-kpi-value">{formatNumber(m.searches)}</span></div>
          </div>

          {@const topContent = v.mostStarted ?? []}
          {#if topContent.length > 0}
            <div class="a2-section">
              <h3 class="a2-section-title">Top Content</h3>
              <!-- Phase 3 mobile: card list (visible <768px). Read-only. -->
              <ul class="a2-analytics-card-list a2-top-content-card-list" role="list">
                {#each topContent as item, i}
                  <li>
                    <div class="a2-top-content-card">
                      <div class="a2-top-content-card-head">
                        <span class="a2-rank mono">#{i + 1}</span>
                        <span class="a2-type-chip" data-type={item.content_type ?? 'unknown'}>{item.content_type ?? '—'}</span>
                      </div>
                      <div class="a2-top-content-card-title">{item.title ?? '—'}</div>
                      <div class="a2-top-content-card-foot">
                        <span>Watch starts <span class="mono">{formatNumber(item.count)}</span></span>
                        <span>Unique viewers <span class="mono">{formatNumber(item.unique_viewers)}</span></span>
                      </div>
                    </div>
                  </li>
                {/each}
              </ul>
              <!-- Desktop table (hidden <768px) -->
              <div class="a2-table-wrap a2-top-content-wrap">
                <table class="a2-table">
                  <thead><tr><th>#</th><th>Title</th><th>Type</th><th>Watch Starts</th><th>Unique Viewers</th></tr></thead>
                  <tbody>
                    {#each topContent as item, i}
                      <tr>
                        <td class="mono">{i + 1}</td>
                        <td>{item.title ?? '—'}</td>
                        <td>{item.content_type ?? '—'}</td>
                        <td class="mono">{formatNumber(item.count)}</td>
                        <td class="mono">{formatNumber(item.unique_viewers)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </div>
          {:else}
            <div class="a2-empty-inline">No viewing events in this period.</div>
          {/if}
        {/if}

      <!-- Providers tab -->
      {:else if currentTab === 'providers' && data.providers}
        {@const p = data.providers}
        {#if p.error}
          <div class="a2-analytics-error" role="alert"><AlertCircle size={20} /><p>{p.error}</p></div>
        {:else}
          {@const m = p.metrics}
          <div class="a2-kpi-grid">
            <div class="a2-kpi-card"><span class="a2-kpi-label">Provider Selections</span><span class="a2-kpi-value">{formatNumber(m.totalSelections)}</span></div>
            <div class="a2-kpi-card"><span class="a2-kpi-label">Watch Starts</span><span class="a2-kpi-value">{formatNumber(m.watchStarts)}</span></div>
            <div class="a2-kpi-card"><span class="a2-kpi-label">Switches</span><span class="a2-kpi-value">{formatNumber(m.totalSwitches)}</span></div>
            <div class="a2-kpi-card"><span class="a2-kpi-label">Success Rate</span><span class="a2-kpi-value">{m.successFailureAvailable ? formatPercent(m.successRate) : 'N/A'}</span>{#if !m.successFailureAvailable}<span class="a2-kpi-hint">Not tracked</span>{/if}</div>
          </div>

          {#if p.usage && p.usage.length > 0}
            <div class="a2-section">
              <h3 class="a2-section-title">Provider Usage</h3>
              <!-- Phase 3 mobile: card list (visible <768px). Read-only. -->
              <ul class="a2-analytics-card-list a2-providers-card-list" role="list">
                {#each p.usage as item}
                  <li>
                    <div class="a2-providers-card">
                      <div class="a2-providers-card-head">
                        <span class="a2-providers-card-name">{item.provider_name ?? item.provider_id}</span>
                        {#if item.usage_share != null}<span class="a2-share-chip mono">{formatPercent(item.usage_share)}</span>{/if}
                      </div>
                      <div class="a2-providers-card-foot">
                        <span>Selections <span class="mono">{formatNumber(item.selections)}</span></span>
                        <span>Watch starts <span class="mono">{formatNumber(item.watch_starts)}</span></span>
                        <span>Completes <span class="mono">{formatNumber(item.completed_watches)}</span></span>
                      </div>
                    </div>
                  </li>
                {/each}
              </ul>
              <!-- Desktop table (hidden <768px) -->
              <div class="a2-table-wrap a2-providers-wrap">
                <table class="a2-table">
                  <thead><tr><th>Provider</th><th>Selections</th><th>Watch Starts</th><th>Completes</th><th>Unique Users</th></tr></thead>
                  <tbody>
                    {#each p.usage as item}
                      <tr>
                        <td>{item.provider_name ?? item.provider_id}</td>
                        <td class="mono">{formatNumber(item.selections)}</td>
                        <td class="mono">{formatNumber(item.watch_starts)}</td>
                        <td class="mono">{formatNumber(item.completed_watches)}</td>
                        <td class="mono">{formatNumber(item.unique_users)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </div>
          {:else}
            <div class="a2-empty-inline">No provider activity in this period.</div>
          {/if}
        {/if}

      <!-- Retention tab -->
      {:else if currentTab === 'retention' && data.retention}
        {@const r = data.retention}
        {#if r.error}
          <div class="a2-analytics-error" role="alert"><AlertCircle size={20} /><p>{r.error}</p></div>
        {:else}
          {@const s = r.summary}
          <div class="a2-kpi-grid">
            <div class="a2-kpi-card"><span class="a2-kpi-label">Cohort Size</span><span class="a2-kpi-value">{formatNumber(s?.totalCohortUsers)}</span></div>
            <div class="a2-kpi-card"><span class="a2-kpi-label">D1 Retention</span><span class="a2-kpi-value">{formatPercent(s?.d1Rate)}</span></div>
            <div class="a2-kpi-card"><span class="a2-kpi-label">D7 Retention</span><span class="a2-kpi-value">{formatPercent(s?.d7Rate)}</span></div>
            <div class="a2-kpi-card"><span class="a2-kpi-label">D30 Retention</span><span class="a2-kpi-value">{formatPercent(s?.d30Rate)}</span></div>
          </div>

          {#if r.cohorts && r.cohorts.length > 0}
            <div class="a2-section">
              <h3 class="a2-section-title">Cohort Matrix ({data.retentionCohort})</h3>
              <p class="a2-section-desc">Cohort = users whose first {data.retentionCohort === 'signup' ? 'signup' : data.retentionCohort === 'first-use' ? 'activity' : 'watch'} occurred during the cohort period. Retained = user generated another qualifying activity on day N.</p>
              <!-- Phase 3 mobile: card list (visible <768px). Read-only. -->
              <ul class="a2-analytics-card-list a2-cohort-card-list" role="list">
                {#each r.cohorts as cohort}
                  <li>
                    <div class="a2-cohort-card">
                      <div class="a2-cohort-card-head">
                        <span class="a2-cohort-date mono">{cohort.cohortDate}</span>
                        <span class="a2-cohort-size">Size <span class="mono">{cohort.cohortSize}</span></span>
                      </div>
                      <div class="a2-cohort-card-grid">
                        <div class="a2-cohort-cell">
                          <span class="a2-cohort-cell-label">D1</span>
                          <span class="a2-cohort-cell-count mono">{cohort.d1Retained != null ? cohort.d1Retained : '—'}</span>
                          <span class="a2-cohort-cell-rate mono">{cohort.d1Rate != null ? formatPercent(cohort.d1Rate) : '—'}</span>
                        </div>
                        <div class="a2-cohort-cell">
                          <span class="a2-cohort-cell-label">D7</span>
                          <span class="a2-cohort-cell-count mono">{cohort.d7Retained != null ? cohort.d7Retained : '—'}</span>
                          <span class="a2-cohort-cell-rate mono">{cohort.d7Rate != null ? formatPercent(cohort.d7Rate) : '—'}</span>
                        </div>
                        <div class="a2-cohort-cell">
                          <span class="a2-cohort-cell-label">D30</span>
                          <span class="a2-cohort-cell-count mono">{cohort.d30Retained != null ? cohort.d30Retained : '—'}</span>
                          <span class="a2-cohort-cell-rate mono">{cohort.d30Rate != null ? formatPercent(cohort.d30Rate) : '—'}</span>
                        </div>
                      </div>
                    </div>
                  </li>
                {/each}
              </ul>
              <!-- Desktop table (hidden <768px) -->
              <div class="a2-table-wrap a2-cohort-wrap">
                <table class="a2-table a2-cohort-table">
                  <thead><tr><th>Cohort</th><th>Size</th><th>D1</th><th>D7</th><th>D30</th></tr></thead>
                  <tbody>
                    {#each r.cohorts as cohort}
                      <tr>
                        <td class="mono">{cohort.cohortDate}</td>
                        <td class="mono">{cohort.cohortSize}</td>
                        <td class="mono">{cohort.d1Retained != null ? `${cohort.d1Retained} (${formatPercent(cohort.d1Rate)})` : '—'}</td>
                        <td class="mono">{cohort.d7Retained != null ? `${cohort.d7Retained} (${formatPercent(cohort.d7Rate)})` : '—'}</td>
                        <td class="mono">{cohort.d30Retained != null ? `${cohort.d30Retained} (${formatPercent(cohort.d30Rate)})` : '—'}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </div>
          {:else}
            <div class="a2-empty-inline">No retention cohort available. Guest retention is not supported (cookie-based identity is unreliable for multi-day tracking).</div>
          {/if}
        {/if}
      {/if}
    {/if}
  </AdminPage>
</AdminAppShell>

<style>
  .a2-period-bar { display: inline-flex; align-items: center; gap: var(--a2-space-2); }
  .a2-period-select { background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-xs); padding: 4px 8px; cursor: pointer; }
  .a2-period-date { background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-xs); padding: 4px 8px; }
  .a2-period-sep { color: var(--a2-text-dim); }
  .a2-period-range { font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }

  .a2-analytics-error { display: flex; gap: var(--a2-space-3); align-items: flex-start; padding: var(--a2-space-4); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-md); color: var(--a2-red); }
  .a2-analytics-error-title { margin: 0 0 4px; font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-red); }
  .a2-analytics-error-desc { margin: 0; font-size: var(--a2-text-xs); color: var(--a2-text-muted); }

  .a2-kpi-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: var(--a2-space-3); }
  .a2-kpi-card { display: flex; flex-direction: column; gap: 2px; padding: var(--a2-space-3); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); }
  .a2-kpi-label { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .a2-kpi-value { font-family: var(--a2-font-mono); font-size: var(--a2-text-xl); font-weight: 700; color: var(--a2-text-bright); }
  .a2-kpi-hint { font-size: 9px; color: var(--a2-text-dim); }
  .a2-kpi-comparison { display: inline-flex; align-items: center; gap: 2px; font-size: var(--a2-text-2xs); font-weight: 600; }
  .a2-kpi-comparison[data-tone="green"] { color: var(--a2-green); }
  .a2-kpi-comparison[data-tone="red"] { color: var(--a2-red); }
  .a2-kpi-comparison[data-tone="neutral"] { color: var(--a2-text-dim); }

  .a2-section { display: flex; flex-direction: column; gap: var(--a2-space-2); padding: var(--a2-space-4) 0; }
  .a2-section-title { margin: 0; font-size: var(--a2-text-sm); font-weight: 700; color: var(--a2-text-bright); }
  .a2-section-desc { margin: 0; font-size: var(--a2-text-2xs); color: var(--a2-text-muted); line-height: 1.5; }

  .a2-reach-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: var(--a2-space-2); }
  .a2-reach-card { display: flex; flex-direction: column; gap: 2px; padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); }
  .a2-reach-label { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; font-weight: 700; }
  .a2-reach-value { font-family: var(--a2-font-mono); font-size: var(--a2-text-lg); font-weight: 700; color: var(--a2-text-bright); }
  .a2-reach-hint { font-size: 9px; color: var(--a2-text-dim); }

  .a2-trend-chart { display: flex; align-items: flex-end; gap: 1px; height: 120px; padding: var(--a2-space-2); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); overflow-x: auto; }
  .a2-trend-bar { flex: 1; min-width: 4px; background: var(--a2-cyan-soft); border-top: 2px solid var(--a2-cyan); border-radius: 1px 1px 0 0; display: flex; align-items: flex-start; justify-content: center; position: relative; transition: background var(--a2-motion-micro, 140ms) var(--a2-ease-out); }
  .a2-trend-bar:hover { background: var(--a2-cyan-border); }
  .a2-trend-bar-value { position: absolute; top: -14px; font-size: 8px; color: var(--a2-text-dim); font-family: var(--a2-font-mono); }

  .a2-funnel { display: flex; flex-direction: column; gap: var(--a2-space-1); }
  .a2-funnel-stage { display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); border-left: 3px solid var(--a2-cyan); width: var(--stage-pct, 100%); min-width: 200px; transition: width var(--a2-motion-normal, 240ms) var(--a2-ease-out); }
  .a2-funnel-stage-num { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 50%; background: var(--a2-surface-4); color: var(--a2-cyan); font-size: var(--a2-text-2xs); font-weight: 700; }
  .a2-funnel-stage-label { font-size: var(--a2-text-xs); color: var(--a2-text); }
  .a2-funnel-stage-count { font-family: var(--a2-font-mono); font-size: var(--a2-text-sm); font-weight: 700; color: var(--a2-text-bright); }

  .a2-table-wrap { overflow-x: auto; background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); }
  .a2-table { width: 100%; border-collapse: collapse; font-size: var(--a2-text-xs); }
  .a2-table thead th { padding: var(--a2-space-2) var(--a2-space-3); text-align: left; font-size: var(--a2-text-2xs); font-weight: 700; color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid var(--a2-border-strong); white-space: nowrap; background: var(--a2-surface-3); }
  .a2-table tbody tr { border-bottom: 1px solid var(--a2-border); }
  .a2-table tbody tr:hover { background: var(--a2-surface-3); }
  .a2-table tbody td { padding: var(--a2-space-2) var(--a2-space-3); color: var(--a2-text); }
  .a2-cohort-table td { white-space: nowrap; }

  .a2-user-cell { display: flex; flex-direction: column; gap: 1px; }
  .a2-user-name { font-weight: 600; color: var(--a2-text-bright); }
  .a2-row-link { color: var(--a2-text-muted); text-decoration: none; display: inline-flex; }
  .a2-row-link:hover { color: var(--a2-cyan); }

  .a2-pagination { display: flex; justify-content: space-between; align-items: center; padding: var(--a2-space-2) 0; }
  .a2-page-btn { display: inline-flex; align-items: center; gap: 2px; padding: 4px 10px; background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-2xs); font-weight: 600; cursor: pointer; }
  .a2-page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .a2-page-btn:hover:not(:disabled) { border-color: var(--a2-cyan); color: var(--a2-cyan); }
  .a2-page-info { font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }

  .a2-empty { display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-8); text-align: center; color: var(--a2-text-muted); }
  .a2-empty h3 { margin: 0; font-size: var(--a2-text-base); color: var(--a2-text); }
  .a2-empty p { margin: 0; font-size: var(--a2-text-sm); max-width: 420px; }
  .a2-empty-inline { padding: var(--a2-space-4); text-align: center; color: var(--a2-text-muted); font-size: var(--a2-text-sm); }

  .mono { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); }

  /* ---- Phase 3 mobile card lists (hidden by default, shown <768px) ---- */
  .a2-analytics-card-list { display: none; list-style: none; margin: 0; padding: 0; gap: var(--a2-space-2); flex-direction: column; }
  .a2-analytics-card-list > li { margin: 0; }

  /* Users card */
  .a2-users-card { display: flex; flex-direction: column; gap: var(--a2-space-2); padding: var(--a2-space-3) var(--a2-space-4); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); color: inherit; text-decoration: none; transition: border-color var(--a2-motion-micro, 140ms) var(--a2-ease-out), background var(--a2-motion-micro, 140ms) var(--a2-ease-out); }
  .a2-users-card:hover { background: var(--a2-surface-3); border-color: var(--a2-cyan-border); }
  .a2-users-card-head { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .a2-users-role-badge { display: inline-flex; padding: 1px 6px; background: var(--a2-surface-4); border-radius: var(--a2-radius-xs); font-size: var(--a2-text-2xs); font-weight: 700; text-transform: uppercase; color: var(--a2-cyan); }
  .a2-users-role-badge[data-role="admin"] { color: var(--a2-amber); }
  .a2-users-chip { display: inline-flex; padding: 1px 6px; background: var(--a2-surface-4); border-radius: var(--a2-radius-xs); font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }
  .a2-users-chip-good { color: var(--a2-green); background: var(--a2-green-soft); }
  .a2-users-card-name { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); word-break: break-word; }
  .a2-users-card-email { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); }
  .a2-users-card-foot { display: flex; justify-content: space-between; align-items: center; gap: var(--a2-space-2); font-size: var(--a2-text-2xs); color: var(--a2-text-muted); flex-wrap: wrap; padding-top: var(--a2-space-1); border-top: 1px solid var(--a2-border); }
  .a2-users-card-open { display: inline-flex; align-items: center; gap: 2px; color: var(--a2-cyan); font-weight: 600; }

  /* Top Content card */
  .a2-top-content-card { display: flex; flex-direction: column; gap: var(--a2-space-2); padding: var(--a2-space-3) var(--a2-space-4); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); }
  .a2-top-content-card-head { display: flex; align-items: center; gap: var(--a2-space-2); }
  .a2-rank { font-size: var(--a2-text-xs); font-weight: 700; color: var(--a2-text-dim); }
  .a2-type-chip { display: inline-flex; padding: 1px 6px; background: var(--a2-surface-4); border-radius: var(--a2-radius-xs); font-size: var(--a2-text-2xs); text-transform: uppercase; color: var(--a2-cyan); }
  .a2-type-chip[data-type="movie"] { color: var(--a2-cyan); }
  .a2-type-chip[data-type="series"] { color: var(--a2-amber); }
  .a2-type-chip[data-type="anime"] { color: var(--a2-green); }
  .a2-top-content-card-title { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); word-break: break-word; }
  .a2-top-content-card-foot { display: flex; gap: var(--a2-space-4); font-size: var(--a2-text-2xs); color: var(--a2-text-muted); flex-wrap: wrap; padding-top: var(--a2-space-1); border-top: 1px solid var(--a2-border); }

  /* Provider Usage card */
  .a2-providers-card { display: flex; flex-direction: column; gap: var(--a2-space-2); padding: var(--a2-space-3) var(--a2-space-4); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); }
  .a2-providers-card-head { display: flex; justify-content: space-between; align-items: center; gap: var(--a2-space-2); }
  .a2-providers-card-name { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); word-break: break-word; }
  .a2-share-chip { padding: 1px 6px; background: var(--a2-cyan-soft); border-radius: var(--a2-radius-xs); font-size: var(--a2-text-2xs); font-weight: 700; color: var(--a2-cyan); }
  .a2-providers-card-foot { display: flex; gap: var(--a2-space-4); font-size: var(--a2-text-2xs); color: var(--a2-text-muted); flex-wrap: wrap; padding-top: var(--a2-space-1); border-top: 1px solid var(--a2-border); }

  /* Cohort Matrix card */
  .a2-cohort-card { display: flex; flex-direction: column; gap: var(--a2-space-2); padding: var(--a2-space-3) var(--a2-space-4); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); }
  .a2-cohort-card-head { display: flex; justify-content: space-between; align-items: center; gap: var(--a2-space-2); }
  .a2-cohort-date { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); }
  .a2-cohort-size { font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }
  .a2-cohort-card-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--a2-space-2); padding-top: var(--a2-space-1); border-top: 1px solid var(--a2-border); }
  .a2-cohort-cell { display: flex; flex-direction: column; align-items: center; gap: 1px; padding: var(--a2-space-2); background: var(--a2-surface-3); border-radius: var(--a2-radius-sm); }
  .a2-cohort-cell-label { font-size: var(--a2-text-2xs); font-weight: 700; color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em; }
  .a2-cohort-cell-count { font-size: var(--a2-text-base); font-weight: 700; color: var(--a2-text-bright); }
  .a2-cohort-cell-rate { font-size: var(--a2-text-2xs); color: var(--a2-cyan); }

  @media (max-width: 768px) {
    .a2-kpi-grid { grid-template-columns: 1fr 1fr; }
    .a2-reach-grid { grid-template-columns: 1fr 1fr; }
    .a2-period-bar { flex-wrap: wrap; }
    .a2-period-range { display: none; }
    /* Phase 3: show mobile card lists, hide desktop tables */
    .a2-analytics-card-list { display: flex; }
    .a2-users-wrap, .a2-top-content-wrap, .a2-providers-wrap, .a2-cohort-wrap { display: none; }
    .a2-page-btn { min-height: 44px; padding: 8px 12px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .a2-trend-bar, .a2-funnel-stage { transition: none; }
  }
</style>
