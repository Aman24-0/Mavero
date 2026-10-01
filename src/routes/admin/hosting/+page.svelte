<script lang="ts">
  /**
   * Admin 2.0 — Hosting Control workspace.
   *
   * ARCHITECTURE: Hosting Control is the single hosting/operations workspace.
   * It contains 5 tabs:
   *   - Providers — provider overview + health + capabilities
   *   - Sync — provider sync + detached assets
   *   - Jobs — active + recent upload operations
   *   - Activity — immutable audit timeline (media_operations)
   *   - Attention — failed/stale/unconfigured/degraded items
   *
   * The old standalone Operations Center page (/admin/operations) now
   * redirects to /admin/hosting?tab=jobs.
   */

  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminHostingProviders from '$lib/components/admin2/AdminHostingProviders.svelte';
  import AdminHostingSync from '$lib/components/admin2/AdminHostingSync.svelte';
  import AdminOpsJobs from '$lib/components/admin2/AdminOpsJobs.svelte';
  import AdminOpsHistory from '$lib/components/admin2/AdminOpsHistory.svelte';
  import AdminOpsAttention from '$lib/components/admin2/AdminOpsAttention.svelte';
  import type { HostingProviderOverview } from '$lib/shared/hosting-types';
  import type { OpsBadgeCounts } from '$lib/shared/operations-types';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // ============================================================
  // Tab state — URL-driven
  // ============================================================
  const VALID_TABS = new Set(['providers', 'sync', 'jobs', 'activity', 'attention']);
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
  // Sync handler
  // ============================================================
  let syncError = $state<string | null>(null);

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
  // Tabs definition — 5 tabs
  // ============================================================
  const tabs = $derived([
    { id: 'providers', label: 'Providers' },
    { id: 'sync', label: 'Sync' },
    { id: 'jobs', label: 'Jobs', badge: badgeCounts.jobsActive > 0 ? String(badgeCounts.jobsActive) : undefined },
    { id: 'activity', label: 'Activity' },
    { id: 'attention', label: 'Attention', badge: badgeCounts.attentionTotal > 0 ? String(badgeCounts.attentionTotal) : undefined },
  ]);

  const syncProviders = $derived(
    providers.map((p) => ({
      adapterId: p.adapterId,
      name: p.name,
      enabled: p.enabled && p.sourceEnabled,
      lastSyncAt: p.lastSyncAt,
      assetCounts: p.assetCounts,
    }))
  );
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
        onopenassets={openAssetsForProvider}
      />
    {:else if currentTab === 'sync'}
      <AdminHostingSync
        providers={syncProviders}
        onopenassets={openAssetsForProvider}
      />
    {:else if currentTab === 'jobs'}
      <AdminOpsJobs {badgeCounts} />
    {:else if currentTab === 'activity'}
      <AdminOpsHistory />
    {:else if currentTab === 'attention'}
      <AdminOpsAttention />
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
