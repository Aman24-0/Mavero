<script lang="ts">
  /**
   * Admin 2.0 — Hosting Control workspace.
   *
   * Phase 2C consolidation: the Assets tab has been merged into Media
   * Library (?view=files). This workspace now has two tabs:
   *   - Providers — provider overview + health + capabilities + detail drawer
   *   - Sync — provider sync + unlinked assets
   *
   * "Open in Assets" actions from Providers/Sync now navigate to
   * /admin/media/library?view=files (the canonical provider-file workspace).
   *
   * Tab state is URL-driven (?tab=providers|sync). The server loader
   * preloads the providers list (skipHealth=true for fast initial
   * render); the Providers tab triggers a live health check client-side.
   */

  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminHostingProviders from '$lib/components/admin2/AdminHostingProviders.svelte';
  import AdminHostingSync from '$lib/components/admin2/AdminHostingSync.svelte';
  import type { HostingProviderOverview } from '$lib/shared/hosting-types';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // ============================================================
  // Tab state — URL-driven
  // ============================================================
  const VALID_TABS = new Set(['providers', 'sync']);
  // svelte-ignore state_referenced_locally — intentional initial capture from URL
  let currentTab = $state<string>(VALID_TABS.has(data.initialTab) ? data.initialTab : 'providers');

  // Sync URL → tab state. We read the tab from the URL on mount and on
  // navigation. Changing tabs updates the URL via replaceState.
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
  // svelte-ignore state_referenced_locally — intentional initial capture from server loader
  let providers = $state<HostingProviderOverview[]>(data.initialProviders);
  // svelte-ignore state_referenced_locally — intentional initial capture from server loader
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

  // ============================================================
  // Cross-tab navigation — "Open in Assets" from Providers/Sync
  // Phase 2C: now navigates to Media Library's Provider Files view.
  // ============================================================
  function openAssetsForProvider(adapterId: string) {
    // Navigate to Media Library's Provider Files view with the provider
    // filter pre-selected. The AdminHostingAssets component reads the
    // `provider` URL param to pre-filter.
    goto(`/admin/media/library?view=files&provider=${encodeURIComponent(adapterId)}`);
  }

  // ============================================================
  // Sync handler — called from Providers tab
  // ============================================================
  // FINDING-012 fix: surface sync errors instead of swallowing them.
  // Previously the catch block had a comment "Swallow — the Providers
  // tab will show the error via its own state" but NO error info was
  // passed to the Providers tab. Now sync errors are captured in
  // `syncError` and rendered as an inline error banner.
  let syncError = $state<string | null>(null);
  let syncingProvider = $state<string | null>(null);

  async function syncProvider(adapterId: string): Promise<void> {
    syncingProvider = adapterId;
    syncError = null;
    try {
      const res = await fetch(`/api/admin/media/sync?provider=${adapterId}`, { method: 'POST' });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        syncError = json?.error?.message ?? `Sync failed (HTTP ${res.status}).`;
      } else {
        // Refresh providers to update asset counts + last sync.
        await refreshProviders();
      }
    } catch (err) {
      syncError = err instanceof Error ? err.message : 'Network error during sync.';
    } finally {
      syncingProvider = null;
    }
  }

  // ============================================================
  // Tabs definition
  // Phase 2C consolidation: Assets tab removed — merged into Media
  // Library's "Provider Files" view. Deep links to ?tab=assets are
  // redirected by the server loader.
  // ============================================================
  const tabs = [
    { id: 'providers', label: 'Providers' },
    { id: 'sync', label: 'Sync' },
  ];

  // Sync tab needs a slim provider view.
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
  <title>Hosting — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell active="hosting">
  <AdminPage
    eyebrow="Hosting"
    title="Hosting Control"
    accent="cyan"
    tabs={tabs.map((t) => ({ id: t.id, label: t.label, active: t.id === currentTab, onclick: () => switchTab(t.id) }))}
  >
    {#snippet description()}
      <p>Operational view of Mavero's connected hosting providers. Monitor health, manage provider assets, and synchronize state.</p>
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
