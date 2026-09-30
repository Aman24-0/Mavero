<script lang="ts">
  /**
   * Phase 3 — User Detail page.
   *
   * Shows: account information, activity summary, recent activity
   * timeline (paginated), viewing history, and guest history (pre-login
   * activity stitched via the Phase 1 identity model).
   *
   * All data is server-fetched. The timeline is URL-paginated
   * (?page=, ?pageSize=) so the back button works.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminSection from '$lib/components/admin/AdminSection.svelte';
  import AdminMetricCard from '$lib/components/admin/AdminMetricCard.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import AdminEmptyState from '$lib/components/admin/AdminEmptyState.svelte';
  import { AlertTriangle, ArrowLeft, Activity, Clock, Play, CheckCircle, Monitor, Globe, History, ChevronLeft, ChevronRight } from 'lucide-svelte';
  import { formatUtcDate, formatUtcDateTime } from '$lib/shared/analytics-period';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Timeline pagination (URL-driven).
  function navigate(next: { page?: number }) {
    const params = new URLSearchParams(page.url.searchParams);
    if (next.page !== undefined) {
      if (next.page > 1) params.set('page', String(next.page));
      else params.delete('page');
    }
    const search = params.toString();
    goto(`${page.url.pathname}${search ? `?${search}` : ''}`, { keepFocus: true, noScroll: true });
  }

  const timelineTotalPages = $derived(
    Math.max(1, Math.ceil(data.result.timeline.total / data.timelinePageSize))
  );
  const timelineHasPrev = $derived(data.timelinePage > 1);
  const timelineHasNext = $derived(data.timelinePage < timelineTotalPages);

  // Error / not-found states.
  const hasError = $derived(Boolean(data.result.error));
  const hasAccount = $derived(Boolean(data.result.account));

  // Activity summary card values.
  const summary = $derived(data.result.activitySummary);

  // Human-readable content-type label.
  function contentTypeLabel(t: string | null): string {
    if (t === 'movie') return 'Movie';
    if (t === 'series') return 'Series';
    if (t === 'anime') return 'Anime';
    return t ?? '—';
  }

  // Format seconds as M:SS or H:MM:SS.
  function formatDuration(seconds: number | null): string {
    if (seconds === null) return '—';
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }
</script>

<svelte:head>
  <title>{data.result.account?.display_name ?? data.result.account?.email ?? 'User'} — User Management — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell active="analytics">
  <AdminPage
    eyebrow="People / Analytics"
    title={data.result.account?.display_name ?? 'Unnamed user'}
    accent="cyan"
  >
    {#snippet description()}
      <p>{data.result.account?.email ?? data.userId}</p>
    {/snippet}
    {#snippet actions()}
      <a class="back-link" href="/admin/analytics?tab=users" aria-label="Back to users list">
        <ArrowLeft size={14} />
        <span>Back to users</span>
      </a>
    {/snippet}

  {#if hasError}
    <div class="detail-error" role="alert">
      <span class="error-icon" aria-hidden="true"><AlertTriangle size={22} /></span>
      <div class="error-copy">
        <h2>Unable to load user detail</h2>
        <p>{data.result.error}</p>
      </div>
    </div>
  {:else if !hasAccount}
    <AdminEmptyState
      icon={AlertTriangle}
      title="User not found"
      message="This user does not exist or has been deleted."
    />
  {:else}
    <!-- ============================================================
         ACCOUNT INFORMATION
         ============================================================ -->
    <section class="detail-section" aria-label="Account information">
      <AdminSection eyebrow="Account" title="Information" accent=".">
        <div class="account-grid">
          <div class="account-field">
            <span class="field-label">User ID</span>
            <code class="field-value mono">{data.result.account!.id}</code>
          </div>
          <div class="account-field">
            <span class="field-label">Email</span>
            <span class="field-value">{data.result.account!.email ?? '— no email —'}</span>
          </div>
          <div class="account-field">
            <span class="field-label">Display name</span>
            <span class="field-value">{data.result.account!.display_name ?? '—'}</span>
          </div>
          <div class="account-field">
            <span class="field-label">Role</span>
            <span class="field-value">
              <AdminStatusBadge
                label={data.result.account!.role === 'admin' ? 'Admin' : 'User'}
                tone={data.result.account!.role === 'admin' ? 'good' : 'neutral'}
                dot={false}
              />
            </span>
          </div>
          <div class="account-field">
            <span class="field-label">Account created</span>
            <span class="field-value">{formatUtcDateTime(data.result.account!.created_at)}</span>
          </div>
          <div class="account-field">
            <span class="field-label">Last updated</span>
            <span class="field-value">{formatUtcDateTime(data.result.account!.updated_at)}</span>
          </div>
        </div>
      </AdminSection>
    </section>

    <!-- ============================================================
         ACTIVITY SUMMARY
         ============================================================ -->
    <section class="detail-section" aria-label="Activity summary">
      <h2 class="section-heading">Activity Summary</h2>
      <div class="metric-grid">
        <AdminMetricCard
          label="First active"
          value={summary.first_active ? formatUtcDate(summary.first_active) : '—'}
          status={summary.first_active ? 'first meaningful activity' : 'never active'}
          statusTone="info"
          icon={Clock}
        />
        <AdminMetricCard
          label="Last active"
          value={summary.last_active ? formatUtcDate(summary.last_active) : '—'}
          status={summary.last_active ? 'most recent meaningful activity' : 'never active'}
          statusTone="good"
          icon={Activity}
        />
        <AdminMetricCard
          label="Total sessions"
          value={summary.total_sessions.toLocaleString()}
          status="analytics sessions"
          statusTone="neutral"
          icon={Monitor}
        />
        <AdminMetricCard
          label="Active days"
          value={summary.active_days.toLocaleString()}
          status="days with meaningful activity"
          statusTone="info"
          icon={Clock}
        />
        <AdminMetricCard
          label="Watch starts"
          value={summary.watch_starts.toLocaleString()}
          status="playback initiations"
          statusTone="good"
          icon={Play}
        />
        <AdminMetricCard
          label="Completed watches"
          value={summary.completed_watches.toLocaleString()}
          status="watch_complete events"
          statusTone="good"
          icon={CheckCircle}
        />
        <AdminMetricCard
          label="Watch progress events"
          value={summary.watch_progress_events.toLocaleString()}
          status="engagement signal"
          statusTone="info"
          icon={Activity}
        />
      </div>
    </section>

    <!-- ============================================================
         GUEST HISTORY (pre-login activity, identity-stitched)
         ============================================================ -->
    {#if data.result.guestHistory && data.result.guestHistory.anonymous_ids.length > 0}
      <section class="detail-section" aria-label="Guest history">
        <AdminSection
          eyebrow="Identity"
          title="Guest history"
          accent="."
          description="Pre-login activity associated with this account via the Phase 1 anonymous_id ↔ user_id co-occurrence model. Anonymous IDs are NOT displayed to avoid unnecessary exposure."
        >
          <div class="guest-grid">
            <div class="guest-field">
              <span class="field-label">Associated browsers</span>
              <span class="field-value mono">{data.result.guestHistory.anonymous_ids.length.toLocaleString()}</span>
            </div>
            <div class="guest-field">
              <span class="field-label">First seen</span>
              <span class="field-value">{data.result.guestHistory.first_seen ? formatUtcDateTime(data.result.guestHistory.first_seen) : '—'}</span>
            </div>
            <div class="guest-field">
              <span class="field-label">Total events</span>
              <span class="field-value mono">{data.result.guestHistory.total_events.toLocaleString()}</span>
            </div>
            <div class="guest-field">
              <span class="field-label">Pre-login activity</span>
              <span class="field-value">
                <AdminStatusBadge
                  label={data.result.guestHistory.has_pre_login_activity ? 'Yes' : 'No'}
                  tone={data.result.guestHistory.has_pre_login_activity ? 'info' : 'neutral'}
                  dot={false}
                />
              </span>
            </div>
          </div>
        </AdminSection>
      </section>
    {/if}

    <!-- ============================================================
         VIEWING HISTORY
         ============================================================ -->
    <section class="detail-section" aria-label="Viewing history">
      <h2 class="section-heading">Viewing History</h2>
      {#if data.result.viewingHistory.length === 0}
        <AdminEmptyState
          icon={Play}
          title="No viewing history"
          message="This user has not started watching any content, or no watch events have been recorded yet."
        />
      {:else}
        <div class="viewing-table-wrapper" role="region" aria-label="Viewing history">
          <table class="viewing-table">
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Type</th>
                <th scope="col">Last watched</th>
                <th scope="col">Progress</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {#each data.result.viewingHistory.slice(0, 50) as entry (entry.content_id)}
                <tr>
                  <td class="title-cell">
                    <strong class="viewing-title">{entry.title ?? entry.content_id}</strong>
                    {#if entry.title}<code class="viewing-id">{entry.content_id}</code>{/if}
                  </td>
                  <td>{contentTypeLabel(entry.content_type)}</td>
                  <td>{formatUtcDateTime(entry.last_watched)}</td>
                  <td class="mono">
                    {#if entry.last_position !== null && entry.last_duration !== null && entry.last_duration > 0}
                      {formatDuration(entry.last_position)} / {formatDuration(entry.last_duration)}
                    {:else if entry.last_position !== null}
                      {formatDuration(entry.last_position)}
                    {:else}
                      —
                    {/if}
                  </td>
                  <td>
                    <AdminStatusBadge
                      label={entry.completed ? 'Completed' : 'In progress'}
                      tone={entry.completed ? 'good' : 'info'}
                      dot={false}
                    />
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if data.result.viewingHistory.length > 50}
          <p class="viewing-note">
            Showing 50 of {data.result.viewingHistory.length.toLocaleString()} unique titles.
            The full history is available in the activity timeline below.
          </p>
        {/if}
      {/if}
    </section>

    <!-- ============================================================
         ACTIVITY TIMELINE
         ============================================================ -->
    <section class="detail-section" aria-label="Activity timeline">
      <h2 class="section-heading">Activity Timeline</h2>
      {#if data.result.timeline.events.length === 0}
        <AdminEmptyState
          icon={History}
          title="No activity recorded"
          message="This user has no analytics events yet."
        />
      {:else}
        <ol class="timeline-list" role="list">
          {#each data.result.timeline.events as event (event.event_id)}
            <li class="timeline-item">
              <span class="timeline-time">{formatUtcDateTime(event.event_time)}</span>
              <span class="timeline-event">
                <strong class="timeline-label">{event.label}</strong>
                {#if event.summary}<span class="timeline-summary">{event.summary}</span>{/if}
                {#if event.content_id}<code class="timeline-content">{event.content_id}</code>{/if}
              </span>
            </li>
          {/each}
        </ol>

        <nav class="pagination" aria-label="Timeline pagination">
          <span class="pagination-info">
            {#if data.result.timeline.totalIsApproximate}
              Showing {data.result.timeline.events.length} of {data.result.timeline.total.toLocaleString()}+ events
            {:else}
              Showing {data.result.timeline.events.length} of {data.result.timeline.total.toLocaleString()} events
            {/if}
            · Page {data.timelinePage} of {timelineTotalPages.toLocaleString()}
          </span>
          <div class="pagination-controls">
            <button
              type="button"
              class="page-btn"
              onclick={() => navigate({ page: data.timelinePage - 1 })}
              disabled={!timelineHasPrev}
              aria-label="Previous page"
            >
              <ChevronLeft size={14} /> Prev
            </button>
            <button
              type="button"
              class="page-btn"
              onclick={() => navigate({ page: data.timelinePage + 1 })}
              disabled={!timelineHasNext}
              aria-label="Next page"
            >
              Next <ChevronRight size={14} />
            </button>
          </div>
        </nav>
      {/if}
    </section>
  {/if}
</AdminPage>
</AdminAppShell>

<style>
  .back-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    padding: 0 14px;
    border: 1px solid var(--color-border-strong);
    border-radius: 999px;
    background: var(--color-surface);
    color: var(--color-text-muted);
    font-size: .62rem;
    font-weight: 600;
    letter-spacing: .04em;
    text-transform: uppercase;
    text-decoration: none;
    transition: border-color var(--motion-fast) var(--ease-out),
                color var(--motion-fast) var(--ease-out);
  }
  .back-link:hover {
    border-color: var(--color-primary-border);
    color: var(--color-text);
  }
  .back-link:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 2px;
  }

  .detail-section {
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

  .account-grid,
  .guest-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 14px;
  }
  .account-field,
  .guest-field {
    display: grid;
    gap: 4px;
  }
  .field-label {
    color: var(--color-text-deep);
    font-size: .53rem;
    font-weight: 800;
    letter-spacing: .14em;
    text-transform: uppercase;
  }
  .field-value {
    color: var(--color-text);
    font-size: .76rem;
    word-break: break-all;
  }
  .field-value.mono {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .68rem;
  }

  .metric-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
  }

  .viewing-table-wrapper {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    overflow-x: auto;
  }
  .viewing-table {
    width: 100%;
    border-collapse: collapse;
    font-size: .72rem;
  }
  .viewing-table thead {
    border-bottom: 1px solid var(--color-border-strong);
  }
  .viewing-table th {
    padding: 10px 14px;
    text-align: left;
    color: var(--color-text-deep);
    font-size: .56rem;
    font-weight: 800;
    letter-spacing: .12em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .viewing-table td {
    padding: 12px 14px;
    border-top: 1px solid var(--color-border);
    color: var(--color-text-muted);
    white-space: nowrap;
  }
  .viewing-table .mono {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }
  .title-cell {
    min-width: 200px;
  }
  .viewing-title {
    color: var(--color-text);
    font-size: .76rem;
    font-weight: 700;
    display: block;
  }
  .viewing-id {
    color: var(--color-text-deep);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .6rem;
  }
  .viewing-note {
    margin-top: 10px;
    color: var(--color-text-deep);
    font-size: .6rem;
    font-style: italic;
  }

  .timeline-list {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .timeline-item {
    display: grid;
    grid-template-columns: 200px 1fr;
    gap: 14px;
    padding: 10px 14px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
  }
  .timeline-time {
    color: var(--color-text-deep);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .62rem;
    white-space: nowrap;
  }
  .timeline-event {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .timeline-label {
    color: var(--color-text);
    font-size: .72rem;
    font-weight: 700;
  }
  .timeline-summary {
    color: var(--color-text-muted);
    font-size: .68rem;
  }
  .timeline-content {
    color: var(--color-text-deep);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .6rem;
  }

  .pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 16px;
    padding: 12px 4px;
  }
  .pagination-info {
    color: var(--color-text-muted);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .6rem;
    letter-spacing: .02em;
  }
  .pagination-controls {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .page-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 32px;
    padding: 0 14px;
    border: 1px solid var(--color-border-strong);
    border-radius: 999px;
    background: var(--color-surface);
    color: var(--color-text-muted);
    font-size: .62rem;
    font-weight: 600;
    letter-spacing: .04em;
    text-transform: uppercase;
    cursor: pointer;
    transition: border-color var(--motion-fast) var(--ease-out),
                color var(--motion-fast) var(--ease-out);
  }
  .page-btn:hover:not(:disabled) {
    border-color: var(--color-primary-border);
    color: var(--color-text);
  }
  .page-btn:disabled {
    opacity: .4;
    cursor: not-allowed;
  }
  .page-btn:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 2px;
  }

  .detail-error {
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

  @media (max-width: 640px) {
    .timeline-item {
      grid-template-columns: 1fr;
      gap: 4px;
    }
    .timeline-time {
      font-size: .58rem;
    }
    .pagination {
      flex-direction: column;
      align-items: stretch;
    }
    .pagination-controls {
      justify-content: space-between;
    }
  }
</style>
