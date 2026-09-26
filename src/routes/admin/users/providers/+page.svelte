<script lang="ts">
  /**
   * Phase 5 — Provider Analytics page.
   *
   * Displays provider usage (selections, switches, actual watch starts,
   * completions), unique users per provider, provider transitions, switch
   * reasons, and movie/series breakdowns. Success/failure metrics are
   * NOT available (playback_success/playback_failed events are not
   * emitted in the current codebase).
   *
   * All data is server-fetched. URL-driven date range.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
  import AdminMetricCard from '$lib/components/admin/AdminMetricCard.svelte';
  import AdminEmptyState from '$lib/components/admin/AdminEmptyState.svelte';
  import AdminDateRangePicker from '$lib/components/admin/AdminDateRangePicker.svelte';
  import { AlertTriangle, BarChart3, Users, Play, CheckCircle, RefreshCw, ArrowRight } from 'lucide-svelte';
  import { formatUtcDate } from '$lib/shared/analytics-period';
  import type { PageData } from './$types';

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

  const hasError = $derived(Boolean(data.result.error));
  const isEmpty = $derived(
    !hasError &&
    data.result.metrics.totalSelections === 0 &&
    data.result.metrics.totalSwitches === 0 &&
    data.result.metrics.totalWatchStarts === 0
  );

  // Truncate a UUID for display when the provider name is unknown.
  function shortId(id: string): string {
    return id.length > 12 ? `${id.slice(0, 8)}…` : id;
  }

  function providerLabel(entry: { provider_name: string | null; provider_id: string }): string {
    return entry.provider_name ?? `Unknown (${shortId(entry.provider_id)})`;
  }
</script>

<svelte:head>
  <title>Providers — User Management — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminShell active="users-providers">
  <AdminPageHeader
    eyebrow="MAVERO / User Management"
    title="Providers"
    accent="analytics."
    description="Provider selection, switching, and actual usage across the selected period."
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
    <div class="providers-error" role="alert">
      <span class="error-icon" aria-hidden="true"><AlertTriangle size={22} /></span>
      <div class="error-copy">
        <h2>Analytics unavailable</h2>
        <p>{data.result.error}</p>
      </div>
    </div>
  {:else if isEmpty}
    <AdminEmptyState
      icon={BarChart3}
      title="No provider activity for this period"
      message="The selected date range has no provider selection, switch, or watch events. Try a wider range."
    />
  {:else}
    <!-- ============================================================
         PROVIDER OVERVIEW METRICS
         ============================================================ -->
    <section class="metric-section" aria-label="Provider overview">
      <h2 class="section-heading">Provider Overview</h2>
      <div class="metric-grid">
        <AdminMetricCard
          label="Provider Selections"
          value={data.result.metrics.totalSelections.toLocaleString()}
          status="provider_selected events"
          statusTone="info"
          icon={BarChart3}
        />
        <AdminMetricCard
          label="Provider Switches"
          value={data.result.metrics.totalSwitches.toLocaleString()}
          status="provider_switched events"
          statusTone="info"
          icon={RefreshCw}
        />
        <AdminMetricCard
          label="Actual Watch Starts"
          value={data.result.metrics.totalWatchStarts.toLocaleString()}
          status="watch_start (actual provider)"
          statusTone="good"
          icon={Play}
        />
        <AdminMetricCard
          label="Completed Watches"
          value={data.result.metrics.totalCompletedWatches.toLocaleString()}
          status="watch_complete events"
          statusTone="good"
          icon={CheckCircle}
        />
      </div>
    </section>

    <!-- ============================================================
         PROVIDER USAGE TABLE
         ============================================================ -->
    <section class="metric-section" aria-label="Provider usage">
      <h2 class="section-heading">Provider Usage</h2>
      {#if data.result.usage.length === 0}
        <p class="section-empty">No provider usage data for this period.</p>
      {:else}
        <div class="table-wrapper" role="region" aria-label="Provider usage table">
          <table class="providers-table">
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col" class="num-col">Selections</th>
                <th scope="col" class="num-col">Switches To</th>
                <th scope="col" class="num-col">Watch Starts</th>
                <th scope="col" class="num-col">Completions</th>
                <th scope="col" class="num-col">Unique Users</th>
                <th scope="col" class="num-col">Share</th>
              </tr>
            </thead>
            <tbody>
              {#each data.result.usage as entry (entry.provider_id)}
                <tr>
                  <td class="provider-cell">
                    <strong class="provider-name">{providerLabel(entry)}</strong>
                    {#if !entry.provider_name}<code class="provider-id">{shortId(entry.provider_id)}</code>{/if}
                  </td>
                  <td class="num-col">{entry.selections.toLocaleString()}</td>
                  <td class="num-col">{entry.switches_to.toLocaleString()}</td>
                  <td class="num-col">{entry.watch_starts.toLocaleString()}</td>
                  <td class="num-col">{entry.completed_watches.toLocaleString()}</td>
                  <td class="num-col">{entry.unique_users.toLocaleString()}</td>
                  <td class="num-col">{entry.usage_share}%</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <!-- ============================================================
         MOVIES VS SERIES BREAKDOWN (per provider)
         ============================================================ -->
    <section class="metric-section" aria-label="Content type breakdown">
      <h2 class="section-heading">Content Type Breakdown by Provider</h2>
      {#if data.result.usage.length === 0}
        <p class="section-empty">No content type data for this period.</p>
      {:else}
        <div class="table-wrapper" role="region" aria-label="Content type breakdown">
          <table class="providers-table">
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col" class="num-col">Movie Starts</th>
                <th scope="col" class="num-col">Series Starts</th>
                <th scope="col" class="num-col">Anime Starts</th>
                <th scope="col" class="num-col">Other</th>
              </tr>
            </thead>
            <tbody>
              {#each data.result.usage as entry (entry.provider_id)}
                <tr>
                  <td class="provider-cell">
                    <strong class="provider-name">{providerLabel(entry)}</strong>
                  </td>
                  <td class="num-col">{entry.movie_watch_starts.toLocaleString()}</td>
                  <td class="num-col">{entry.series_watch_starts.toLocaleString()}</td>
                  <td class="num-col">{entry.anime_watch_starts.toLocaleString()}</td>
                  <td class="num-col">{entry.other_watch_starts.toLocaleString()}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <!-- ============================================================
         SUCCESS / FAILURE (NOT AVAILABLE)
         ============================================================ -->
    <section class="metric-section" aria-label="Provider success and failure">
      <h2 class="section-heading">Success / Failure</h2>
      <div class="unavailable-card" role="status">
        <AlertTriangle size={18} aria-hidden="true" />
        <div>
          <strong>Not available.</strong>
          <p>
            The <code>playback_success</code> and <code>playback_failed</code> events are defined in the
            Phase 1 taxonomy but are not yet emitted by the player. Success/failure and success-rate
            metrics cannot be computed from the current event data. This is a known limitation —
            see the worklog for details.
          </p>
        </div>
      </div>
    </section>

    <!-- ============================================================
         PROVIDER SWITCHES
         ============================================================ -->
    <section class="metric-section" aria-label="Provider switches">
      <h2 class="section-heading">Provider Switches</h2>
      {#if data.result.metrics.totalSwitches === 0}
        <p class="section-empty">No provider switches for this period.</p>
      {:else}
        <div class="switch-reasons">
          <h3 class="subsection-title">Switch Reasons</h3>
          <div class="reason-pills">
            {#each data.result.switchReasons as reason (reason.reason)}
              <span class="reason-pill">
                {reason.reason}: {reason.count.toLocaleString()}
              </span>
            {/each}
          </div>
        </div>
      {/if}
    </section>

    <!-- ============================================================
         PROVIDER TRANSITION TABLE
         ============================================================ -->
    <section class="metric-section" aria-label="Provider transitions">
      <h2 class="section-heading">Provider Transitions</h2>
      {#if data.result.transitions.length === 0}
        <p class="section-empty">No provider transitions for this period.</p>
      {:else}
        <div class="table-wrapper" role="region" aria-label="Provider transition table">
          <table class="providers-table">
            <thead>
              <tr>
                <th scope="col">From</th>
                <th scope="col" aria-label="transition arrow"></th>
                <th scope="col">To</th>
                <th scope="col" class="num-col">Switches</th>
                <th scope="col" class="num-col">Unique Switchers</th>
              </tr>
            </thead>
            <tbody>
              {#each data.result.transitions as entry (entry.from_provider_id + '→' + entry.to_provider_id)}
                <tr>
                  <td>{entry.from_provider_name ?? `Unknown (${shortId(entry.from_provider_id)})`}</td>
                  <td class="arrow-cell" aria-hidden="true"><ArrowRight size={14} /></td>
                  <td>{entry.to_provider_name ?? `Unknown (${shortId(entry.to_provider_id)})`}</td>
                  <td class="num-col">{entry.count.toLocaleString()}</td>
                  <td class="num-col">{entry.unique_switchers.toLocaleString()}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <p class="range-meta">
      Range: {formatUtcDate(data.range.start)} → {formatUtcDate(data.range.end)} (UTC).
      Selections = provider_selected events. Actual usage = watch_start.provider_id (the resolved playback source).
      Success/failure = not available (playback events not yet emitted).
    </p>
  {/if}
</AdminShell>

<style>
  .metric-section { margin-top: 28px; }
  .section-heading {
    margin: 0 0 12px;
    color: var(--color-text);
    font-size: .78rem;
    font-weight: 800;
    letter-spacing: .04em;
    text-transform: uppercase;
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
  .providers-table {
    width: 100%;
    border-collapse: collapse;
    font-size: .72rem;
  }
  .providers-table thead { border-bottom: 1px solid var(--color-border-strong); }
  .providers-table th {
    padding: 10px 14px;
    text-align: left;
    color: var(--color-text-deep);
    font-size: .56rem;
    font-weight: 800;
    letter-spacing: .12em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .providers-table td {
    padding: 10px 14px;
    border-top: 1px solid var(--color-border);
    color: var(--color-text-muted);
    white-space: nowrap;
  }
  .num-col {
    text-align: right;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }
  .provider-cell { min-width: 160px; }
  .provider-name {
    color: var(--color-text);
    font-size: .74rem;
    font-weight: 700;
    display: block;
  }
  .provider-id {
    color: var(--color-text-deep);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .58rem;
  }
  .arrow-cell {
    text-align: center;
    color: var(--color-text-deep);
  }

  .unavailable-card {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 14px 16px;
    border: 1px dashed var(--color-border-strong);
    border-radius: var(--radius-md);
    background: rgba(0, 255, 156, .012);
    color: var(--color-warning);
  }
  .unavailable-card strong { color: var(--color-text); font-size: .78rem; }
  .unavailable-card p {
    margin: 4px 0 0;
    color: var(--color-text-muted);
    font-size: .68rem;
    line-height: 1.55;
  }
  .unavailable-card code {
    color: var(--color-primary);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .9em;
  }

  .switch-reasons { margin-top: 4px; }
  .subsection-title {
    margin: 0 0 8px;
    color: var(--color-text);
    font-size: .72rem;
    font-weight: 700;
  }
  .reason-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .reason-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-surface);
    color: var(--color-text-muted);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .6rem;
    letter-spacing: .02em;
  }

  .section-empty {
    color: var(--color-text-deep);
    font-size: .68rem;
    font-style: italic;
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

  .providers-error {
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
  }
  @media (max-width: 640px) {
    .metric-grid { grid-template-columns: 1fr; }
  }
</style>
