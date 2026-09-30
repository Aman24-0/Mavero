<script lang="ts">
  /**
   * Admin 2.0 — Phase F — Operations Center workspace.
   *
   * Unified workspace with three contextual tabs:
   *   - Jobs — active + recent upload operations (media_upload_operations)
   *   - Activity — immutable audit timeline (media_operations)
   *   - Attention — failed/stale/unconfigured/degraded items needing action
   *
   * Tab state is URL-driven (?tab=jobs|history|attention).
   * Badge counts are preloaded by the server loader + refreshed client-side.
   */

  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminOpsJobs from '$lib/components/admin2/AdminOpsJobs.svelte';
  import AdminOpsHistory from '$lib/components/admin2/AdminOpsHistory.svelte';
  import AdminOpsAttention from '$lib/components/admin2/AdminOpsAttention.svelte';
  import type { OpsBadgeCounts } from '$lib/shared/operations-types';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const VALID_TABS = new Set(['jobs', 'history', 'attention']);
  // svelte-ignore state_referenced_locally — intentional initial capture from URL
  let currentTab = $state<string>(VALID_TABS.has(data.initialTab) ? data.initialTab : 'jobs');
  // svelte-ignore state_referenced_locally — intentional initial capture from server loader
  let badgeCounts = $state<OpsBadgeCounts>(data.badgeCounts);

  $effect(() => {
    const urlTab = page.url.searchParams.get('tab') ?? 'jobs';
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

  async function refreshBadges() {
    try {
      const res = await fetch('/api/admin/operations/counts');
      const data = await res.json();
      if (data.ok) {
        badgeCounts = { jobsActive: data.jobsActive, attentionTotal: data.attentionTotal };
      }
    } catch {
      // Badges are decorative — don't break the page.
    }
  }

  onMount(() => {
    // Refresh badges on mount + when the page regains focus (cheap endpoint).
    void refreshBadges();
    const onFocus = () => void refreshBadges();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  });

  const tabs = $derived([
    { id: 'jobs', label: 'Jobs', badge: badgeCounts.jobsActive > 0 ? String(badgeCounts.jobsActive) : undefined },
    { id: 'history', label: 'Activity' },
    { id: 'attention', label: 'Attention', badge: badgeCounts.attentionTotal > 0 ? String(badgeCounts.attentionTotal) : undefined },
  ]);
</script>

<svelte:head>
  <title>Operations — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell active="operations">
  <AdminPage
    eyebrow="Operations"
    title="Operations Center"
    accent="cyan"
    tabs={tabs.map((t) => ({ id: t.id, label: t.label, active: t.id === currentTab, onclick: () => switchTab(t.id) }))}
  >
    {#snippet description()}
      <p>Unified view of every background operation — uploads, processing, sync, reconciliation, and management actions. Monitor active jobs, review audit history, and address items needing attention.</p>
    {/snippet}

    {#if currentTab === 'jobs'}
      <AdminOpsJobs badgeCounts={badgeCounts} />
    {:else if currentTab === 'history'}
      <AdminOpsHistory />
    {:else if currentTab === 'attention'}
      <AdminOpsAttention />
    {/if}
  </AdminPage>
</AdminAppShell>
