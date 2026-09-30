<script lang="ts">
  /**
   * Phase 4 — Viewing & Discovery Analytics page.
   *
   * Displays viewing metrics (unique viewers, watch starts, completed
   * watches, watch time, movies vs series), content rankings (most
   * watched/started/completed/trending), genre breakdown, and
   * discovery/search analytics. All data is server-fetched (no
   * client-side aggregation). The page re-navigates on date-range
   * changes so the URL is the single source of truth.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
  import AdminMetricCard from '$lib/components/admin/AdminMetricCard.svelte';
  import AdminEmptyState from '$lib/components/admin/AdminEmptyState.svelte';
  import AdminDateRangePicker from '$lib/components/admin/AdminDateRangePicker.svelte';
  import { AlertTriangle, Play, CheckCircle, Clock, Users, Search, TrendingUp, Film, Tv, Sparkles } from 'lucide-svelte';
  import { formatUtcDate } from '$lib/shared/analytics-period';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // URL-driven navigation for date-range changes.
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

  // Error / empty states.
  const hasError = $derived(Boolean(data.result.error));
  const isEmpty = $derived(
    !hasError &&
    data.result.metrics.watchStarts === 0 &&
    data.result.metrics.completedWatches === 0 &&
    data.result.search.totalSearches === 0
  );

  // Format seconds as a human-readable duration (e.g. "1h 23m" or "45m").
  function formatWatchTime(seconds: number | null): string {
    if (seconds === null) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  // Content-type label for the rankings.
  function contentTypeLabel(t: string | null): string {
    if (t === 'movie') return 'Movie';
    if (t === 'series') return 'Series';
    if (t === 'anime') return 'Anime';
    return t ?? '—';
  }

  // Content-type icon for the breakdown.
  function contentTypeIcon(t: string | null) {
    if (t === 'movie') return Film;
    if (t === 'series' || t === 'anime') return Tv;
    return Sparkles;
  }
</script>

<svelte:head>
  <title>Viewing & Discovery — User Management — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminShell active="users-viewing">
  <AdminPageHeader
    eyebrow="MAVERO / User Management"
    title="Viewing"
    accent="& discovery."
    description="What Mavero users are watching and searching for across the selected period."
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
    <div class="viewing-error" role="alert">
      <span class="error-icon" aria-hidden="true"><AlertTriangle size={22} /></span>
      <div class="error-copy">
        <h2>Analytics unavailable</h2>
        <p>{data.result.error}</p>
      </div>
    </div>
  {:else if isEmpty}
    <AdminEmptyState
      icon={Play}
      title="No viewing or search activity for this period"
      message="The selected date range has no watch or search events. Try a wider range, or wait for users to generate activity."
    />
  {:else}
    <!-- ============================================================
         PRIMARY VIEWING METRICS
         ============================================================ -->
    <section class="metric-section" aria-label="Viewing metrics">
      <h2 class="section-heading">Viewing</h2>
      <div class="metric-grid">
        <AdminMetricCard
          label="Unique Viewers"
          value={data.result.metrics.uniqueViewers.toLocaleString()}
          status="distinct identities"
          statusTone="good"
          icon={Users}
        />
        <AdminMetricCard
          label="Watch Starts"
          value={data.result.metrics.watchStarts.toLocaleString()}
          status="playback initiations"
          statusTone="info"
          icon={Play}
        />
        <AdminMetricCard
          label="Completed Watches"
          value={data.result.metrics.completedWatches.toLocaleString()}
          status="watch_complete events"
          statusTone="good"
          icon={CheckCircle}
        />
        <AdminMetricCard
          label="Watch Time (approx.)"
          value={formatWatchTime(data.result.metrics.watchTimeSeconds)}
          status={data.result.metrics.watchTimeSeconds === null ? 'not available' : 'from watch_progress'}
          statusTone={data.result.metrics.watchTimeSeconds === null ? 'neutral' : 'info'}
          icon={Clock}
        />
      </div>
    </section>

    <!-- ============================================================
         MOVIES VS SERIES BREAKDOWN
         ============================================================ -->
    <section class="metric-section" aria-label="Movies vs series">
      <h2 class="section-heading">Movies vs Series</h2>
      <div class="breakdown-grid">
        <div class="breakdown-card">
          <h3 class="breakdown-title">Watch Starts</h3>
          <div class="breakdown-rows">
            <div class="breakdown-row">
              <span class="breakdown-label"><Film size={14} /> Movies</span>
              <span class="breakdown-value">{data.result.metrics.movieWatchStarts.toLocaleString()}</span>
            </div>
            <div class="breakdown-row">
              <span class="breakdown-label"><Tv size={14} /> Series</span>
              <span class="breakdown-value">{data.result.metrics.seriesWatchStarts.toLocaleString()}</span>
            </div>
            <div class="breakdown-row">
              <span class="breakdown-label"><Tv size={14} /> Anime</span>
              <span class="breakdown-value">{data.result.metrics.animeWatchStarts.toLocaleString()}</span>
            </div>
            {#if data.result.metrics.otherWatchStarts > 0}
              <div class="breakdown-row">
                <span class="breakdown-label"><Sparkles size={14} /> Other</span>
                <span class="breakdown-value">{data.result.metrics.otherWatchStarts.toLocaleString()}</span>
              </div>
            {/if}
          </div>
        </div>
        <div class="breakdown-card">
          <h3 class="breakdown-title">Completed Watches</h3>
          <div class="breakdown-rows">
            <div class="breakdown-row">
              <span class="breakdown-label"><Film size={14} /> Movies</span>
              <span class="breakdown-value">{data.result.metrics.movieCompletedWatches.toLocaleString()}</span>
            </div>
            <div class="breakdown-row">
              <span class="breakdown-label"><Tv size={14} /> Series</span>
              <span class="breakdown-value">{data.result.metrics.seriesCompletedWatches.toLocaleString()}</span>
            </div>
            <div class="breakdown-row">
              <span class="breakdown-label"><Tv size={14} /> Anime</span>
              <span class="breakdown-value">{data.result.metrics.animeCompletedWatches.toLocaleString()}</span>
            </div>
            {#if data.result.metrics.otherCompletedWatches > 0}
              <div class="breakdown-row">
                <span class="breakdown-label"><Sparkles size={14} /> Other</span>
                <span class="breakdown-value">{data.result.metrics.otherCompletedWatches.toLocaleString()}</span>
              </div>
            {/if}
          </div>
        </div>
      </div>
    </section>

    <!-- ============================================================
         VIEWING RANKINGS — Most Watched / Most Started / Most Completed / Trending
         ============================================================ -->
    <section class="metric-section" aria-label="Content rankings">
      <h2 class="section-heading">Content Rankings</h2>
      <div class="rankings-grid">
        <div class="ranking-card">
          <h3 class="ranking-title"><TrendingUp size={15} /> Most Watched</h3>
          <p class="ranking-desc">Top titles by unique viewers</p>
          {#if data.result.mostWatched.length === 0}
            <p class="ranking-empty">No watch activity.</p>
          {:else}
            <ol class="ranking-list" role="list">
              {#each data.result.mostWatched.slice(0, 10) as entry, i (entry.content_id)}
                <li class="ranking-item">
                  <span class="ranking-rank">{i + 1}</span>
                  <div class="ranking-content">
                    <strong class="ranking-name">{entry.title ?? 'Unknown title'}</strong>
                    <span class="ranking-meta">{contentTypeLabel(entry.content_type)} · {entry.unique_viewers.toLocaleString()} viewers</span>
                  </div>
                </li>
              {/each}
            </ol>
          {/if}
        </div>

        <div class="ranking-card">
          <h3 class="ranking-title"><Play size={15} /> Most Started</h3>
          <p class="ranking-desc">Top titles by watch starts</p>
          {#if data.result.mostStarted.length === 0}
            <p class="ranking-empty">No watch starts.</p>
          {:else}
            <ol class="ranking-list" role="list">
              {#each data.result.mostStarted.slice(0, 10) as entry, i (entry.content_id)}
                <li class="ranking-item">
                  <span class="ranking-rank">{i + 1}</span>
                  <div class="ranking-content">
                    <strong class="ranking-name">{entry.title ?? 'Unknown title'}</strong>
                    <span class="ranking-meta">{contentTypeLabel(entry.content_type)} · {entry.count.toLocaleString()} starts</span>
                  </div>
                </li>
              {/each}
            </ol>
          {/if}
        </div>

        <div class="ranking-card">
          <h3 class="ranking-title"><CheckCircle size={15} /> Most Completed</h3>
          <p class="ranking-desc">Top titles by completed watches</p>
          {#if data.result.mostCompleted.length === 0}
            <p class="ranking-empty">No completed watches.</p>
          {:else}
            <ol class="ranking-list" role="list">
              {#each data.result.mostCompleted.slice(0, 10) as entry, i (entry.content_id)}
                <li class="ranking-item">
                  <span class="ranking-rank">{i + 1}</span>
                  <div class="ranking-content">
                    <strong class="ranking-name">{entry.title ?? 'Unknown title'}</strong>
                    <span class="ranking-meta">{contentTypeLabel(entry.content_type)} · {entry.count.toLocaleString()} completions</span>
                  </div>
                </li>
              {/each}
            </ol>
          {/if}
        </div>

        <div class="ranking-card">
          <h3 class="ranking-title"><TrendingUp size={15} /> Trending</h3>
          <p class="ranking-desc">Watch starts in the selected period</p>
          {#if data.result.trending.length === 0}
            <p class="ranking-empty">No trending content.</p>
          {:else}
            <ol class="ranking-list" role="list">
              {#each data.result.trending.slice(0, 10) as entry, i (entry.content_id)}
                <li class="ranking-item">
                  <span class="ranking-rank">{i + 1}</span>
                  <div class="ranking-content">
                    <strong class="ranking-name">{entry.title ?? 'Unknown title'}</strong>
                    <span class="ranking-meta">{contentTypeLabel(entry.content_type)} · {entry.count.toLocaleString()} starts</span>
                  </div>
                </li>
              {/each}
            </ol>
          {/if}
        </div>
      </div>
    </section>

    <!-- ============================================================
         GENRE BREAKDOWN
         ============================================================ -->
    <section class="metric-section" aria-label="Genre breakdown">
      <h2 class="section-heading">Genre Breakdown</h2>
      {#if data.result.genres.length === 0}
        <p class="section-empty">No genre data available for this period.</p>
      {:else}
        <div class="genre-table-wrapper" role="region" aria-label="Genre breakdown">
          <table class="genre-table">
            <thead>
              <tr>
                <th scope="col">Genre</th>
                <th scope="col" class="num-col">Watch Starts</th>
              </tr>
            </thead>
            <tbody>
              {#each data.result.genres as entry (entry.genre)}
                <tr>
                  <td>{entry.genre}</td>
                  <td class="num-col">{entry.watch_starts.toLocaleString()}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <!-- ============================================================
         DISCOVERY / SEARCH ANALYTICS
         ============================================================ -->
    <section class="metric-section" aria-label="Discovery and search analytics">
      <h2 class="section-heading">Discovery & Search</h2>
      <div class="metric-grid">
        <AdminMetricCard
          label="Total Searches"
          value={data.result.search.totalSearches.toLocaleString()}
          status="search events"
          statusTone="info"
          icon={Search}
        />
        <AdminMetricCard
          label="Unique Searchers"
          value={data.result.search.uniqueSearchers.toLocaleString()}
          status="distinct identities"
          statusTone="good"
          icon={Users}
        />
        <AdminMetricCard
          label="No-Result Searches"
          value={data.result.search.noResultSearches.toLocaleString()}
          status={data.result.search.totalSearches > 0 ? `${Math.round((data.result.search.noResultSearches / data.result.search.totalSearches) * 100)}% of total` : '—'}
          statusTone={data.result.search.noResultSearches > 0 ? 'warn' : 'neutral'}
          icon={Search}
        />
      </div>

      {#if data.result.search.topQueries.length > 0}
        <div class="search-queries-card">
          <h3 class="subsection-title">Most Searched Queries</h3>
          <div class="search-queries-table-wrapper" role="region" aria-label="Most searched queries">
            <table class="search-queries-table">
              <thead>
                <tr>
                  <th scope="col">Query</th>
                  <th scope="col" class="num-col">Searches</th>
                  <th scope="col" class="num-col">No Results</th>
                </tr>
              </thead>
              <tbody>
                {#each data.result.search.topQueries as entry (entry.query)}
                  <tr>
                    <td class="query-cell">{entry.query}</td>
                    <td class="num-col">{entry.count.toLocaleString()}</td>
                    <td class="num-col">{entry.no_result_count.toLocaleString()}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      {/if}
    </section>

    <p class="range-meta">
      Range: {formatUtcDate(data.range.start)} → {formatUtcDate(data.range.end)} (UTC).
      Watch time is approximate (from watch_progress max position_seconds).
      Trending = watch starts in the selected period.
    </p>
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
  .metric-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
  }

  /* Movies vs Series breakdown */
  .breakdown-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .breakdown-card {
    padding: 14px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }
  .breakdown-title {
    margin: 0 0 10px;
    color: var(--color-text-deep);
    font-size: .56rem;
    font-weight: 800;
    letter-spacing: .14em;
    text-transform: uppercase;
  }
  .breakdown-rows {
    display: grid;
    gap: 6px;
  }
  .breakdown-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .breakdown-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--color-text-muted);
    font-size: .72rem;
  }
  .breakdown-value {
    color: var(--color-text);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .82rem;
    font-weight: 800;
  }

  /* Rankings */
  .rankings-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
  }
  .ranking-card {
    padding: 14px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }
  .ranking-title {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 4px;
    color: var(--color-text);
    font-size: .72rem;
    font-weight: 700;
  }
  .ranking-desc {
    margin: 0 0 10px;
    color: var(--color-text-deep);
    font-size: .58rem;
    letter-spacing: .04em;
  }
  .ranking-list {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .ranking-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 0;
    border-top: 1px solid var(--color-border);
  }
  .ranking-item:first-child {
    border-top: none;
  }
  .ranking-rank {
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    border: 1px solid var(--color-primary-border);
    border-radius: 50%;
    background: var(--color-primary-soft);
    color: var(--color-primary);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .58rem;
    font-weight: 700;
  }
  .ranking-content {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .ranking-name {
    color: var(--color-text);
    font-size: .72rem;
    font-weight: 700;
    word-break: break-word;
  }
  .ranking-meta {
    color: var(--color-text-deep);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .58rem;
  }
  .ranking-empty {
    color: var(--color-text-deep);
    font-size: .68rem;
    font-style: italic;
  }

  /* Genre table */
  .genre-table-wrapper,
  .search-queries-table-wrapper {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    overflow-x: auto;
  }
  .genre-table,
  .search-queries-table {
    width: 100%;
    border-collapse: collapse;
    font-size: .72rem;
  }
  .genre-table thead,
  .search-queries-table thead {
    border-bottom: 1px solid var(--color-border-strong);
  }
  .genre-table th,
  .search-queries-table th {
    padding: 10px 14px;
    text-align: left;
    color: var(--color-text-deep);
    font-size: .56rem;
    font-weight: 800;
    letter-spacing: .12em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .genre-table td,
  .search-queries-table td {
    padding: 10px 14px;
    border-top: 1px solid var(--color-border);
    color: var(--color-text-muted);
    white-space: nowrap;
  }
  .num-col {
    text-align: right;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }
  .query-cell {
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Search queries subsection */
  .search-queries-card {
    margin-top: 14px;
  }
  .subsection-title {
    margin: 0 0 8px;
    color: var(--color-text);
    font-size: .72rem;
    font-weight: 700;
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

  /* Error state */
  .viewing-error {
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
    margin: 0;
    color: var(--color-text-muted);
    font-size: .74rem;
    line-height: 1.55;
  }

  /* Responsive */
  @media (max-width: 1024px) {
    .metric-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .rankings-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 640px) {
    .metric-grid,
    .breakdown-grid,
    .rankings-grid {
      grid-template-columns: 1fr;
    }
    .query-cell {
      max-width: 180px;
    }
  }
</style>
