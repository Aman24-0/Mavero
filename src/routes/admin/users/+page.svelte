<script lang="ts">
  /**
   * Phase 3 — User Management list page.
   *
   * Displays a searchable, filterable, paginated list of registered
   * users. All state is URL-driven (search/filter/page/pageSize/period)
   * so the page is refresh/share/back-button safe.
   *
   * Each row shows: user (display name + email), account created,
   * first active, last active, sessions, watch starts, and an
   * activity-status badge. Clicking a row navigates to the user
   * detail page at /admin/users/[userId].
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
  import AdminEmptyState from '$lib/components/admin/AdminEmptyState.svelte';
  import AdminDateRangePicker from '$lib/components/admin/AdminDateRangePicker.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import { AlertTriangle, Search, ChevronLeft, ChevronRight, Users as UsersIcon, X } from 'lucide-svelte';
  import { formatUtcDate, formatUtcDateTime } from '$lib/shared/analytics-period';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // URL-driven navigation helper.
  function navigate(next: { q?: string; filter?: string; page?: number; pageSize?: number; preset?: string; from?: string; to?: string }) {
    const params = new URLSearchParams(page.url.searchParams);
    if (next.q !== undefined) {
      if (next.q) params.set('q', next.q);
      else params.delete('q');
      // Reset to page 1 on search change.
      params.delete('page');
    }
    if (next.filter !== undefined) {
      params.set('filter', next.filter);
      // Reset to page 1 on filter change.
      params.delete('page');
    }
    if (next.page !== undefined) {
      if (next.page > 1) params.set('page', String(next.page));
      else params.delete('page');
    }
    if (next.pageSize !== undefined) {
      params.set('pageSize', String(next.pageSize));
      params.delete('page');
    }
    if (next.preset !== undefined) {
      params.set('period', next.preset);
      if (next.preset !== 'custom') {
        params.delete('from');
        params.delete('to');
      } else {
        if (next.from) params.set('from', next.from);
        if (next.to) params.set('to', next.to);
      }
      params.delete('page');
    }
    const search = params.toString();
    goto(`${page.url.pathname}${search ? `?${search}` : ''}`, { keepFocus: true, noScroll: true });
  }

  // Search input — local state synced to URL on submit. Initialized
  // empty; the $effect below syncs from data.search when it changes.
  let searchInput = $state('');
  $effect(() => {
    searchInput = data.search;
  });

  function submitSearch(event: SubmitEvent) {
    event.preventDefault();
    navigate({ q: searchInput.trim() });
  }

  function clearSearch() {
    searchInput = '';
    navigate({ q: '' });
  }

  function onSelectRange(next: { preset: string; from?: string; to?: string }) {
    navigate(next);
  }

  // Pagination helpers.
  const totalPages = $derived(Math.max(1, Math.ceil(data.result.total / data.pageSize)));
  const hasPrev = $derived(data.page > 1);
  const hasNext = $derived(data.page < totalPages);

  // Status badge for a user's activity state.
  function statusBadge(user: PageData['result']['users'][number]): { label: string; tone: 'good' | 'info' | 'neutral' } {
    if (user.is_new) return { label: 'New', tone: 'good' };
    if (user.is_returning) return { label: 'Returning', tone: 'info' };
    if (user.is_active) return { label: 'Active', tone: 'good' };
    return { label: 'Inactive', tone: 'neutral' };
  }

  // Error / empty states.
  const hasError = $derived(Boolean(data.result.error));
  const isEmpty = $derived(!hasError && data.result.users.length === 0);
</script>

<svelte:head>
  <title>Users — User Management — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminShell active="users-list">
  <AdminPageHeader
    eyebrow="MAVERO / User Management"
    title="Users"
    accent="directory."
    description="Search, filter, and inspect registered Mavero accounts and their analytics activity."
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
    <div class="users-error" role="alert">
      <span class="error-icon" aria-hidden="true"><AlertTriangle size={22} /></span>
      <div class="error-copy">
        <h2>Unable to load users</h2>
        <p>{data.result.error}</p>
      </div>
    </div>
  {:else}
    <!-- ============================================================
         SEARCH + FILTER BAR
         ============================================================ -->
    <div class="controls-bar">
      <form class="search-form" onsubmit={submitSearch} role="search">
        <label class="search-field">
          <span class="visually-hidden">Search users by email or display name</span>
          <Search size={14} class="search-icon" aria-hidden="true" />
          <input
            type="search"
            class="search-input"
            placeholder="Search by email or display name…"
            bind:value={searchInput}
            maxlength="200"
            aria-label="Search users by email or display name"
          />
          {#if searchInput}
            <button type="button" class="search-clear" onclick={clearSearch} aria-label="Clear search">
              <X size={14} />
            </button>
          {/if}
        </label>
        <button type="submit" class="search-btn">Search</button>
      </form>

      <div class="filter-group" role="group" aria-label="User type filter">
        {#each data.filterOptions as opt}
          <button
            type="button"
            class="filter-pill"
            class:active={data.filter === opt.id}
            onclick={() => navigate({ filter: opt.id })}
            aria-pressed={data.filter === opt.id}
          >{opt.label}</button>
        {/each}
      </div>
    </div>

    {#if isEmpty}
      <AdminEmptyState
        icon={UsersIcon}
        title={data.search ? `No users match "${data.search}"` : 'No users found'}
        message={data.search
          ? 'Try a different search term, or clear the search to see all users.'
          : 'No registered users match the current filter for the selected period.'}
      />
    {:else}
      <!-- ============================================================
           USERS TABLE
           ============================================================ -->
      <div class="users-table-wrapper" role="region" aria-label="Users list">
        <table class="users-table">
          <thead>
            <tr>
              <th scope="col">User</th>
              <th scope="col">Account created</th>
              <th scope="col">First active</th>
              <th scope="col">Last active</th>
              <th scope="col" class="num-col">Sessions</th>
              <th scope="col" class="num-col">Watch starts</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {#each data.result.users as user (user.id)}
              <tr class="user-row" onclick={() => goto(`/admin/users/${user.id}`)}
                  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goto(`/admin/users/${user.id}`); } }}
                  role="button" tabindex="0"
                  aria-label={`View details for ${user.display_name ?? user.email ?? user.id}`}>
                <td class="user-cell">
                  <div class="user-id">
                    <strong class="user-name">{user.display_name ?? 'Unnamed user'}</strong>
                    <span class="user-email">{user.email ?? '— no email —'}</span>
                  </div>
                </td>
                <td>{formatUtcDate(user.created_at)}</td>
                <td>{user.first_active ? formatUtcDateTime(user.first_active) : '—'}</td>
                <td>{user.last_active ? formatUtcDateTime(user.last_active) : '—'}</td>
                <td class="num-col">{user.session_count.toLocaleString()}</td>
                <td class="num-col">{user.watch_starts.toLocaleString()}</td>
                <td>
                  <AdminStatusBadge
                    label={statusBadge(user).label}
                    tone={statusBadge(user).tone}
                    dot={false}
                  />
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <!-- ============================================================
           PAGINATION
           ============================================================ -->
      <nav class="pagination" aria-label="Users pagination">
        <span class="pagination-info">
          {#if data.result.totalIsApproximate}
            Showing {data.result.users.length} of {data.result.total.toLocaleString()}+ users
          {:else}
            Showing {data.result.users.length} of {data.result.total.toLocaleString()} users
          {/if}
          · Page {data.page} of {totalPages.toLocaleString()}
        </span>
        <div class="pagination-controls">
          <button
            type="button"
            class="page-btn"
            onclick={() => navigate({ page: data.page - 1 })}
            disabled={!hasPrev}
            aria-label="Previous page"
          >
            <ChevronLeft size={14} /> Prev
          </button>
          <button
            type="button"
            class="page-btn"
            onclick={() => navigate({ page: data.page + 1 })}
            disabled={!hasNext}
            aria-label="Next page"
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      </nav>
    {/if}
  {/if}
</AdminShell>

<style>
  .controls-bar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-top: 24px;
    margin-bottom: 16px;
  }
  .search-form {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1 1 320px;
    min-width: 240px;
  }
  .search-field {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    padding: 0 12px;
    border: 1px solid var(--color-border-strong);
    border-radius: 999px;
    background: var(--color-surface-elevated);
  }
  .search-field:focus-within {
    border-color: var(--color-primary-border);
    box-shadow: var(--glow-primary);
  }
  :global(.search-icon) {
    color: var(--color-text-deep);
    flex-shrink: 0;
  }
  .search-input {
    flex: 1;
    min-height: 36px;
    border: none;
    background: transparent;
    color: var(--color-text);
    font-size: .76rem;
    outline: none;
  }
  .search-input::placeholder {
    color: var(--color-text-deep);
  }
  .search-clear {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--color-text-muted);
    cursor: pointer;
  }
  .search-clear:hover {
    background: var(--color-surface-raised);
    color: var(--color-text);
  }
  .search-clear:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 1px;
  }
  .search-btn {
    min-height: 36px;
    padding: 0 16px;
    border: 1px solid var(--color-primary-border);
    border-radius: 999px;
    background: var(--color-primary);
    color: #050708;
    font-size: .64rem;
    font-weight: 700;
    letter-spacing: .04em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .search-btn:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 2px;
  }
  .filter-group {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-surface);
  }
  .filter-pill {
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
  .filter-pill:hover {
    color: var(--color-text);
  }
  .filter-pill.active {
    background: var(--color-primary-soft);
    color: var(--color-primary);
  }
  .filter-pill:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 1px;
  }

  .users-table-wrapper {
    margin-top: 8px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    overflow-x: auto;
  }
  .users-table {
    width: 100%;
    border-collapse: collapse;
    font-size: .72rem;
  }
  .users-table thead {
    border-bottom: 1px solid var(--color-border-strong);
  }
  .users-table th {
    padding: 10px 14px;
    text-align: left;
    color: var(--color-text-deep);
    font-size: .56rem;
    font-weight: 800;
    letter-spacing: .12em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .users-table th.num-col,
  .users-table td.num-col {
    text-align: right;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }
  .users-table td {
    padding: 12px 14px;
    border-top: 1px solid var(--color-border);
    color: var(--color-text-muted);
    white-space: nowrap;
  }
  .user-row {
    cursor: pointer;
    transition: background var(--motion-fast) var(--ease-out);
  }
  .user-row:hover {
    background: rgba(0, 255, 156, .025);
  }
  .user-row:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: -2px;
  }
  .user-cell {
    min-width: 200px;
  }
  .user-id {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .user-name {
    color: var(--color-text);
    font-size: .76rem;
    font-weight: 700;
  }
  .user-email {
    color: var(--color-text-deep);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .62rem;
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

  .users-error {
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

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @media (max-width: 1024px) {
    .controls-bar {
      flex-direction: column;
      align-items: stretch;
    }
    .filter-group {
      overflow-x: auto;
      flex-wrap: nowrap;
    }
  }
  @media (max-width: 640px) {
    .users-table th,
    .users-table td {
      padding: 10px 10px;
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
