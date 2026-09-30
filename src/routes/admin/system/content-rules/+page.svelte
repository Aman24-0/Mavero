<script lang="ts">
  /**
   * Admin 2.0 — Phase G — Content Rules workspace.
   *
   * Unified workspace with two contextual tabs:
   *   - Categories — category registry with source assignments
   *   - Feature Control — feature flags (currently Adult Mode policy)
   *
   * Categories tab shows the category list in the Admin 2.0 shell with
   * a link to the legacy /admin/categories page for full CRUD (the
   * legacy form is 573 lines — Phase G wraps it, not rewrites it).
   *
   * Feature Control tab surfaces the Adult Mode policy toggles
   * (allowLoggedIn, allowGuest) via the existing /api/admin/adult-mode
   * endpoint. Phase G fixes the missing auth gate (the legacy
   * /admin/feature-control page had NO +page.server.ts — no SSR auth).
   */

  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminStatus from '$lib/components/admin2/AdminStatus.svelte';
  import { Layers, ExternalLink, Check, AlertCircle, Loader2, ShieldCheck, ToggleLeft, ToggleRight } from 'lucide-svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const VALID_TABS = new Set(['categories', 'features']);
  let currentTab = $state<string>(VALID_TABS.has(data.initialTab) ? data.initialTab : 'categories');

  $effect(() => {
    const urlTab = page.url.searchParams.get('tab') ?? 'categories';
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

  // --- Feature Control state ---
  let adultPolicy = $state<{ allowLoggedIn: boolean; allowGuest: boolean } | null>(null);
  let adultPolicyLoading = $state(false);
  let adultPolicySaving = $state(false);
  let adultPolicyError = $state<string | null>(null);
  let adultPolicySuccess = $state<string | null>(null);

  async function loadAdultPolicy() {
    adultPolicyLoading = true;
    adultPolicyError = null;
    try {
      const res = await fetch('/api/admin/adult-mode');
      const json = await res.json();
      if (json.ok) {
        adultPolicy = { allowLoggedIn: Boolean(json.policy?.allowLoggedIn), allowGuest: Boolean(json.policy?.allowGuest) };
      } else {
        adultPolicyError = json.error?.message ?? 'Failed to load feature policy.';
      }
    } catch {
      adultPolicyError = 'Network error while loading feature policy.';
    }
    adultPolicyLoading = false;
  }

  async function togglePolicy(key: 'allowLoggedIn' | 'allowGuest') {
    if (!adultPolicy || adultPolicySaving) return;
    adultPolicySaving = true;
    adultPolicyError = null;
    adultPolicySuccess = null;
    const newPolicy = { ...adultPolicy, [key]: !adultPolicy[key] };
    try {
      const res = await fetch('/api/admin/adult-mode', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newPolicy),
      });
      const json = await res.json();
      if (json.ok) {
        adultPolicy = newPolicy;
        adultPolicySuccess = 'Feature policy updated.';
      } else {
        adultPolicyError = json.error?.message ?? 'Failed to update feature policy.';
      }
    } catch {
      adultPolicyError = 'Network error while updating feature policy.';
    }
    adultPolicySaving = false;
  }

  onMount(() => {
    if (currentTab === 'features') void loadAdultPolicy();
  });

  $effect(() => {
    if (currentTab === 'features' && !adultPolicy && !adultPolicyLoading) {
      void loadAdultPolicy();
    }
  });

  // --- Category helpers ---
  function sourceCountForCategory(categoryId: string): number {
    return data.sourceCategories.filter((sc: any) => sc.category_id === categoryId).length;
  }

  const tabs = [
    { id: 'categories', label: 'Categories' },
    { id: 'features', label: 'Feature Control' },
  ];
</script>

<svelte:head>
  <title>Content Rules — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell active="content-rules">
  <AdminPage
    eyebrow="System"
    title="Content Rules"
    accent="cyan"
    tabs={tabs.map((t) => ({ id: t.id, label: t.label, active: t.id === currentTab, onclick: () => switchTab(t.id) }))}
  >
    {#snippet description()}
      <p>Manage content categories and feature controls. Categories group sources for the resolver; feature controls toggle platform-wide behavior.</p>
    {/snippet}

    {#if data.notice}
      <div class="a2-notice" role="status"><Check size={14} /> {data.notice}</div>
    {/if}

    {#if currentTab === 'categories'}
      {#if data.categories.length === 0}
        <div class="a2-empty">
          <Layers size={32} />
          <h3>No categories configured</h3>
          <p>Create categories to group sources and control resolver ordering.</p>
        </div>
      {:else}
        <div class="a2-category-table-wrap">
          <table class="a2-category-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Slug</th>
                <th>Enabled</th>
                <th>Sources</th>
                <th>Ordering</th>
              </tr>
            </thead>
            <tbody>
              {#each data.categories as cat (cat.id)}
                <tr>
                  <td>
                    <div class="a2-cat-cell">
                      <span class="a2-cat-icon">📂</span>
                      <span class="a2-cat-name">{cat.name}</span>
                    </div>
                  </td>
                  <td class="mono">{cat.slug}</td>
                  <td>
                    {#if cat.enabled}
                      <AdminStatus label="Enabled" tone="green" />
                    {:else}
                      <AdminStatus label="Disabled" tone="neutral" />
                    {/if}
                  </td>
                  <td>{sourceCountForCategory(cat.id)}</td>
                  <td class="mono">{cat.ordering}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        <div class="a2-legacy-link">
          <a href="/admin/categories" class="a2-legacy-link-btn">
            <ExternalLink size={12} /> Open category registry (full CRUD + source assignment)
          </a>
        </div>
      {/if}
    {:else if currentTab === 'features'}
      <div class="a2-features">
        <h3 class="a2-features-section-title"><ShieldCheck size={14} /> Adult Mode Policy</h3>
        <p class="a2-features-desc">
          Controls who can access adult content on Mavero. These toggles are enforced server-side
          via the central adult-policy module.
        </p>

        {#if adultPolicyLoading}
          <div class="a2-features-loading" role="status">
            <Loader2 size={16} style="animation: a2-spin 1s linear infinite; color: var(--a2-cyan);" />
            <span>Loading feature policy…</span>
          </div>
        {:else if adultPolicyError}
          <div class="a2-features-error" role="alert">
            <AlertCircle size={14} /> {adultPolicyError}
            <button type="button" class="a2-features-retry" onclick={loadAdultPolicy}>Retry</button>
          </div>
        {:else if adultPolicy}
          {#if adultPolicySuccess}
            <p class="a2-features-success" role="status"><Check size={12} /> {adultPolicySuccess}</p>
          {/if}
          <div class="a2-feature-row">
            <div class="a2-feature-row-info">
              <span class="a2-feature-row-label">Allow logged-in users</span>
              <span class="a2-feature-row-desc">Authenticated users can access adult content if their account allows it.</span>
            </div>
            <button
              type="button"
              class="a2-toggle"
              class:is-on={adultPolicy.allowLoggedIn}
              onclick={() => togglePolicy('allowLoggedIn')}
              disabled={adultPolicySaving}
              aria-pressed={adultPolicy.allowLoggedIn}
              aria-label="Toggle allow logged-in users"
            >
              {#if adultPolicy.allowLoggedIn}<ToggleRight size={24} />{:else}<ToggleLeft size={24} />{/if}
            </button>
          </div>
          <div class="a2-feature-row">
            <div class="a2-feature-row-info">
              <span class="a2-feature-row-label">Allow guests</span>
              <span class="a2-feature-row-desc">Unauthenticated visitors can access adult content (not recommended).</span>
            </div>
            <button
              type="button"
              class="a2-toggle"
              class:is-on={adultPolicy.allowGuest}
              onclick={() => togglePolicy('allowGuest')}
              disabled={adultPolicySaving}
              aria-pressed={adultPolicy.allowGuest}
              aria-label="Toggle allow guests"
            >
              {#if adultPolicy.allowGuest}<ToggleRight size={24} />{:else}<ToggleLeft size={24} />{/if}
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </AdminPage>
</AdminAppShell>

<style>
  .a2-notice {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-green-soft); border: 1px solid var(--a2-green-border);
    border-radius: var(--a2-radius-sm); color: var(--a2-green); font-size: var(--a2-text-sm);
  }

  .a2-empty {
    display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-3);
    padding: var(--a2-space-8); text-align: center; color: var(--a2-text-muted);
  }
  .a2-empty h3 { margin: 0; font-size: var(--a2-text-base); color: var(--a2-text); }
  .a2-empty p { margin: 0; font-size: var(--a2-text-sm); max-width: 420px; }

  .a2-category-table-wrap {
    overflow-x: auto; background: var(--a2-surface-2);
    border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md);
  }
  .a2-category-table { width: 100%; border-collapse: collapse; font-size: var(--a2-text-xs); }
  .a2-category-table thead th {
    padding: var(--a2-space-2) var(--a2-space-3); text-align: left;
    font-size: var(--a2-text-2xs); font-weight: 700; color: var(--a2-text-dim);
    text-transform: uppercase; letter-spacing: 0.06em;
    border-bottom: 1px solid var(--a2-border-strong); background: var(--a2-surface-3);
  }
  .a2-category-table tbody tr { border-bottom: 1px solid var(--a2-border); }
  .a2-category-table tbody tr:hover { background: var(--a2-surface-3); }
  .a2-category-table tbody td { padding: var(--a2-space-2) var(--a2-space-3); color: var(--a2-text); }

  .a2-cat-cell { display: inline-flex; align-items: center; gap: var(--a2-space-2); }
  .a2-cat-icon { font-size: 16px; }
  .a2-cat-name { font-weight: 600; color: var(--a2-text-bright); }

  .a2-legacy-link { padding: var(--a2-space-3) 0; }
  .a2-legacy-link-btn {
    display: inline-flex; align-items: center; gap: var(--a2-space-1);
    padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-surface-3); border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm); color: var(--a2-text-muted);
    font-size: var(--a2-text-2xs); font-weight: 600; text-decoration: none;
    transition: all var(--a2-motion-micro, 140ms) var(--a2-ease-out);
  }
  .a2-legacy-link-btn:hover { color: var(--a2-cyan); border-color: var(--a2-cyan-border); }

  /* ---- Feature Control ---- */
  .a2-features { display: flex; flex-direction: column; gap: var(--a2-space-3); }
  .a2-features-section-title {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    margin: 0; font-size: var(--a2-text-sm); font-weight: 700; color: var(--a2-text-bright);
  }
  .a2-features-desc { margin: 0; font-size: var(--a2-text-sm); color: var(--a2-text-muted); line-height: 1.5; max-width: 560px; }

  .a2-features-loading { display: inline-flex; align-items: center; gap: var(--a2-space-2); color: var(--a2-text-muted); font-size: var(--a2-text-sm); padding: var(--a2-space-4); }
  .a2-features-error {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-red-soft); border: 1px solid var(--a2-red-border);
    border-radius: var(--a2-radius-sm); color: var(--a2-red); font-size: var(--a2-text-sm);
  }
  .a2-features-retry { padding: 2px 8px; background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-xs); color: var(--a2-text); font-size: var(--a2-text-2xs); cursor: pointer; }
  .a2-features-success {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-green-soft); border: 1px solid var(--a2-green-border);
    border-radius: var(--a2-radius-sm); color: var(--a2-green); font-size: var(--a2-text-sm);
  }

  .a2-feature-row {
    display: flex; justify-content: space-between; align-items: center;
    gap: var(--a2-space-4);
    padding: var(--a2-space-3) var(--a2-space-4);
    background: var(--a2-surface-2); border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
  }
  .a2-feature-row-info { display: flex; flex-direction: column; gap: 2px; }
  .a2-feature-row-label { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); }
  .a2-feature-row-desc { font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }

  .a2-toggle {
    background: transparent; border: none; cursor: pointer;
    color: var(--a2-text-dim); padding: 0; display: inline-flex; align-items: center;
    transition: color var(--a2-motion-micro, 140ms) var(--a2-ease-out);
  }
  .a2-toggle.is-on { color: var(--a2-green); }
  .a2-toggle:disabled { opacity: 0.5; cursor: not-allowed; }

  .mono { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); }

  @keyframes a2-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  @media (prefers-reduced-motion: reduce) {
    .a2-toggle, .a2-legacy-link-btn { transition: none; }
  }
</style>
