<script lang="ts">
  /**
   * Admin 2.0 — Hosting Control workspace.
   *
   * ARCHITECTURE (final 3-issue fix — Hosting navigation consolidation):
   * Hosting Control is the single hosting/operations workspace with 3 tabs:
   *   - Providers — provider overview + health + capabilities + ALL sync
   *     actions (Refresh health + Sync all providers in the page action
   *     area, per-provider Sync on each card)
   *   - Jobs — active + recent upload operations
   *   - Activity — immutable audit timeline (media_operations)
   *
   * The separate Sync tab was removed as redundant: the provider page
   * already hosts every sync affordance. The Sync-all backend action
   * (POST /api/admin/media/sync, no provider param), the per-provider
   * sync backend (POST /api/admin/media/sync?provider=<adapter>), the
   * sync service, and sync jobs/history are all preserved unchanged —
   * only the redundant separate UI section is gone.
   *
   * Legacy URLs redirect server-side (+page.server.ts):
   *   /admin/hosting?tab=sync      → /admin/hosting (Providers)
   *   /admin/hosting?tab=attention → /admin/hosting (Providers)
   *   /admin/hosting?tab=assets    → /admin/media/library
   *   /admin/hosting?tab=history   → ?tab=activity
   *   /admin/operations?tab=X      → /admin/hosting?tab=X
   */

  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminHostingProviders from '$lib/components/admin2/AdminHostingProviders.svelte';
  import AdminOpsJobs from '$lib/components/admin2/AdminOpsJobs.svelte';
  import AdminOpsHistory from '$lib/components/admin2/AdminOpsHistory.svelte';
  import type { HostingProviderOverview } from '$lib/shared/hosting-types';
  import type { OpsBadgeCounts } from '$lib/shared/operations-types';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // ============================================================
  // Tab state — URL-driven
  // ============================================================
  const VALID_TABS = new Set(['providers', 'jobs', 'activity']);
  // svelte-ignore state_referenced_locally
  let currentTab = $state<string>(VALID_TABS.has(data.initialTab) ? data.initialTab : 'providers');
  // svelte-ignore state_referenced_locally
  let badgeCounts = $state<OpsBadgeCounts>(data.badgeCounts ?? { jobsActive: 0, attentionTotal: 0 });

  $effect(() => {
    const urlTab = page.url.searchParams.get('tab') ?? 'providers';
    if (VALID_TABS.has(urlTab) && urlTab !== currentTab) {
      currentTab = urlTab;
    }
  });

  function switchTab(tab: string) {
    if (!VALID_TABS.has(tab) || tab === currentTab) return;
    currentTab = tab;
    const params = new URLSearchParams(page.url.searchParams);
    params.set('tab', tab);
    goto(`${page.url.pathname}?${params.toString()}`, { replaceState: true, noScroll: true, invalidateAll: false });
  }

  // ============================================================
  // Provider data — server-preloaded, refreshable client-side
  // ============================================================
  // svelte-ignore state_referenced_locally
  let providers = $state<HostingProviderOverview[]>(data.initialProviders);
  // svelte-ignore state_referenced_locally
  let providersError = $state<string | null>(data.initialProvidersError);

  async function refreshProviders() {
    try {
      const res = await fetch('/api/admin/hosting/providers?skipHealth=1');
      const data = await res.json();
      if (data.ok) {
        providers = data.providers;
        providersError = null;
      } else {
        providersError = data.error?.message ?? 'Failed to load providers.';
      }
    } catch {
      providersError = 'Network error while loading providers.';
    }
  }

  function openAssetsForProvider(adapterId: string) {
    goto(`/admin/media/library?provider=${encodeURIComponent(adapterId)}`);
  }

  // ============================================================
  // Sync handlers — same backend actions as before consolidation
  // ============================================================
  let syncError = $state<string | null>(null);

  /**
   * Sync ALL providers — the exact same backend action the old Sync tab's
   * "Sync all providers" button used: POST /api/admin/media/sync with no
   * provider parameter (SyncService.syncAll). No new sync system.
   */
  async function syncAllProviders(): Promise<void> {
    syncError = null;
    try {
      const res = await fetch('/api/admin/media/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        syncError = data?.error?.message ?? `Sync failed (HTTP ${res.status}).`;
      } else {
        await refreshProviders();
      }
    } catch (err) {
      syncError = err instanceof Error ? err.message : 'Network error during sync.';
    }
  }

  /**
   * Per-provider sync — POST /api/admin/media/sync?provider=<adapter>
   * (SyncService.syncProvider). Used by each provider card's Sync button.
   */
  async function syncProvider(adapterId: string): Promise<void> {
    syncError = null;
    try {
      const res = await fetch(`/api/admin/media/sync?provider=${adapterId}`, { method: 'POST' });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        syncError = json?.error?.message ?? `Sync failed (HTTP ${res.status}).`;
      } else {
        await refreshProviders();
      }
    } catch (err) {
      syncError = err instanceof Error ? err.message : 'Network error during sync.';
    }
  }

  // ============================================================
  // Badge refresh
  // ============================================================
  async function refreshBadges() {
    try {
      const res = await fetch('/api/admin/operations/counts');
      const data = await res.json();
      if (data.ok) {
        badgeCounts = { jobsActive: data.jobsActive, attentionTotal: data.attentionTotal };
      }
    } catch {
      // Badges are decorative.
    }
  }

  onMount(() => {
    void refreshBadges();
    const onFocus = () => void refreshBadges();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  });

  // ============================================================
  // Tabs definition — 3 tabs (Providers / Jobs / Activity)
  // ============================================================
  const tabs = $derived([
    { id: 'providers', label: 'Providers' },
    { id: 'jobs', label: 'Jobs', badge: badgeCounts.jobsActive > 0 ? String(badgeCounts.jobsActive) : undefined },
    { id: 'activity', label: 'Activity' },
  ]);
</script>

<svelte:head>
  <title>Hosting Control — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell active="hosting">
  <AdminPage
    eyebrow="Hosting"
    title="Hosting Control"
    accent="cyan"
    tabs={tabs.map((t) => ({ id: t.id, label: t.label, active: t.id === currentTab, onclick: () => switchTab(t.id), badge: t.badge }))}
  >
    {#snippet description()}
      <p>Single workspace for hosting providers, sync, operations, and monitoring.</p>
    {/snippet}

    {#if currentTab === 'providers'}
      {#if syncError}
        <div class="a2-sync-error" role="alert">
          <strong>Sync failed:</strong> {syncError}
        </div>
      {/if}
      <AdminHostingProviders
        {providers}
        {providersError}
        onsyncprovider={syncProvider}
        onsyncall={syncAllProviders}
        onopenassets={openAssetsForProvider}
      />
    {:else if currentTab === 'jobs'}
      <AdminOpsJobs {badgeCounts} />
    {:else if currentTab === 'activity'}
      <AdminOpsHistory />
    {/if}
  </AdminPage>
</AdminAppShell>

<style>
  .a2-sync-error {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: var(--a2-space-2) var(--a2-space-3);
    margin-bottom: var(--a2-space-3);
    background: var(--a2-red-soft);
    border: 1px solid var(--a2-red-border);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-red);
    font-size: var(--a2-text-sm);
  }
  .a2-sync-error strong { font-weight: 700; }
</style>
