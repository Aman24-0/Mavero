<script lang="ts">
  /**
   * Admin 2.0 — Phase 1 — Content Rules workspace.
   *
   * Full CRUD for categories + feature control toggles.
   * No redirects to legacy UI.
   */

  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminStatus from '$lib/components/admin2/AdminStatus.svelte';
  import AdminSheet from '$lib/components/admin/AdminSheet.svelte';
  import AdminFormSection from '$lib/components/admin/AdminFormSection.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import AdminAddButton from '$lib/components/admin/AdminAddButton.svelte';
  import { Layers, ExternalLink, Check, AlertCircle, Loader2, ShieldCheck, ToggleLeft, ToggleRight, Plus, Edit3, Trash2, Power, X } from 'lucide-svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const VALID_TABS = new Set(['categories', 'features']);
  // svelte-ignore state_referenced_locally
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

  // --- Category edit/create sheet ---
  let categorySheetOpen = $state(false);
  let editingCategory: any = $state(null);

  function openCreateCategory(event?: Event) { editingCategory = null; categorySheetOpen = true; }
  function openEditCategory(cat: any, event?: Event) { editingCategory = cat; categorySheetOpen = true; }
  function closeCategorySheet() { categorySheetOpen = false; editingCategory = null; }

  // --- Feature Control ---
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
        adultPolicyError = json.error?.message ?? 'Failed to load feature policies.';
      }
    } catch { adultPolicyError = 'Network error while loading feature policy.'; }
    adultPolicyLoading = false;
  }

  async function togglePolicy(key: 'allowLoggedIn' | 'allowGuest') {
    if (!adultPolicy || adultPolicySaving) return;
    adultPolicySaving = true;
    adultPolicyError = null;
    adultPolicySuccess = null;
    const newPolicy = { ...adultPolicy, [key]: !adultPolicy[key] };
    try {
      const res = await fetch('/api/admin/adult-mode', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newPolicy) });
      const json = await res.json();
      if (json.ok) { adultPolicy = newPolicy; adultPolicySuccess = 'Feature policy updated.'; }
      else { adultPolicyError = json.error?.message ?? 'Failed to update.'; }
    } catch { adultPolicyError = 'Network error.'; }
    adultPolicySaving = false;
  }

  onMount(() => { if (currentTab === 'features') void loadAdultPolicy(); });
  $effect(() => { if (currentTab === 'features' && !adultPolicy && !adultPolicyLoading) void loadAdultPolicy(); });

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
    {#snippet actions()}
      {#if currentTab === 'categories'}
        <AdminAddButton label="Add category" onclick={openCreateCategory} />
      {/if}
    {/snippet}

    {#snippet description()}
      <p>Manage content categories and feature controls. All CRUD operations are available directly in this workspace.</p>
    {/snippet}

    {#if data.notice}
      <div class="a2-notice" role="status"><Check size={14} /> {data.notice}</div>
    {/if}
    {#if form?.message}
      <div class="a2-form-error" role="alert">{form.message}</div>
    {/if}

    {#if currentTab === 'categories'}
      {#if data.categories.length === 0}
        <div class="a2-empty">
          <Layers size={32} />
          <h3>No categories configured</h3>
          <p>Create categories to group sources and control resolver ordering.</p>
          <AdminAddButton label="Add category" onclick={openCreateCategory} />
        </div>
      {:else}
        <div class="a2-category-list">
          {#each data.categories as cat (cat.id)}
            <div class="a2-category-row" data-enabled={cat.enabled}>
              <div class="a2-category-row-main">
                <span class="a2-category-row-icon">📂</span>
                <div class="a2-category-row-info">
                  <div class="a2-category-row-name">{cat.name}</div>
                  <div class="a2-category-row-meta">
                    <span class="mono">{cat.slug}</span>
                    <span>·</span>
                    <span>{sourceCountForCategory(cat.id)} source(s)</span>
                    <span>·</span>
                    <span>order: {cat.ordering}</span>
                  </div>
                </div>
              </div>
              <div class="a2-category-row-actions">
                <AdminStatusBadge label={cat.enabled ? 'Enabled' : 'Disabled'} tone={cat.enabled ? 'good' : 'neutral'} />
                <form method="POST" action="?/toggleCategory" style="display:inline">
                  <input type="hidden" name="id" value={cat.id} />
                  <input type="hidden" name="enabled" value={String(!cat.enabled)} />
                  <button type="submit" class="a2-icon-btn" title={cat.enabled ? 'Disable' : 'Enable'}><Power size={14} /></button>
                </form>
                <button type="button" class="a2-icon-btn" onclick={() => openEditCategory(cat)} title="Edit"><Edit3 size={14} /></button>
                <form method="POST" action="?/deleteCategory" style="display:inline" onsubmit={() => confirm('Delete this category? This cannot be undone.')}>
                  <input type="hidden" name="id" value={cat.id} />
                  <button type="submit" class="a2-icon-btn a2-icon-btn-danger" title="Delete"><Trash2 size={14} /></button>
                </form>
              </div>
            </div>
          {/each}
        </div>
      {/if}

    {:else if currentTab === 'features'}
      <div class="a2-features">
        <h3 class="a2-features-section-title"><ShieldCheck size={14} /> Adult Mode Policy</h3>
        <p class="a2-features-desc">Controls who can access adult content. Enforced server-side.</p>

        {#if adultPolicyLoading}
          <div class="a2-features-loading" role="status"><Loader2 size={16} style="animation: a2-spin 1s linear infinite; color: var(--a2-cyan);" /> <span>Loading…</span></div>
        {:else if adultPolicyError}
          <div class="a2-features-error" role="alert"><AlertCircle size={14} /> {adultPolicyError} <button type="button" class="a2-features-retry" onclick={loadAdultPolicy}>Retry</button></div>
        {:else if adultPolicy}
          {#if adultPolicySuccess}<p class="a2-features-success" role="status"><Check size={12} /> {adultPolicySuccess}</p>{/if}
          <div class="a2-feature-row">
            <div class="a2-feature-row-info"><span class="a2-feature-row-label">Allow logged-in users</span><span class="a2-feature-row-desc">Authenticated users can access adult content.</span></div>
            <button type="button" class="a2-toggle" class:is-on={adultPolicy.allowLoggedIn} onclick={() => togglePolicy('allowLoggedIn')} disabled={adultPolicySaving} aria-pressed={adultPolicy.allowLoggedIn} aria-label="Toggle allow logged-in">
              {#if adultPolicy.allowLoggedIn}<ToggleRight size={24} />{:else}<ToggleLeft size={24} />{/if}
            </button>
          </div>
          <div class="a2-feature-row">
            <div class="a2-feature-row-info"><span class="a2-feature-row-label">Allow guests</span><span class="a2-feature-row-desc">Unauthenticated visitors can access adult content.</span></div>
            <button type="button" class="a2-toggle" class:is-on={adultPolicy.allowGuest} onclick={() => togglePolicy('allowGuest')} disabled={adultPolicySaving} aria-pressed={adultPolicy.allowGuest} aria-label="Toggle allow guests">
              {#if adultPolicy.allowGuest}<ToggleRight size={24} />{:else}<ToggleLeft size={24} />{/if}
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </AdminPage>
</AdminAppShell>

<!-- Category create/edit sheet -->
{#if categorySheetOpen}
  <AdminSheet open={categorySheetOpen} title={editingCategory ? `Edit ${editingCategory.name}` : 'Add Category'} onClose={closeCategorySheet}>
    <form method="POST" action={editingCategory ? '?/updateCategory' : '?/createCategory'} class="a2-crud-form">
      {#if editingCategory}<input type="hidden" name="id" value={editingCategory.id} />{/if}
      <AdminFormSection heading="Identity">
        <label class="a2-field"><span>Name</span><input name="name" required value={editingCategory?.name ?? ''} /></label>
        <label class="a2-field"><span>Slug</span><input name="slug" required value={editingCategory?.slug ?? ''} /></label>
        <label class="a2-field"><span>Icon (emoji)</span><input name="icon" value={editingCategory?.icon ?? ''} /></label>
        <label class="a2-field"><span>Ordering</span><input type="number" name="ordering" value={editingCategory?.ordering ?? 0} /></label>
        <label class="a2-field"><span>Enabled</span><input type="checkbox" name="enabled" value="true" checked={editingCategory ? editingCategory.enabled : true} /></label>
      </AdminFormSection>
      <AdminFormSection heading="Metadata">
        <label class="a2-field"><span>Description</span><input name="description" value={editingCategory?.description ?? ''} /></label>
      </AdminFormSection>
      <div class="a2-form-actions">
        <button type="submit" class="a2-btn-primary">{editingCategory ? 'Save' : 'Create'}</button>
        <button type="button" class="a2-btn-secondary" onclick={closeCategorySheet}>Cancel</button>
      </div>
    </form>
  </AdminSheet>
{/if}

<style>
  .a2-notice { display: inline-flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-green-soft); border: 1px solid var(--a2-green-border); border-radius: var(--a2-radius-sm); color: var(--a2-green); font-size: var(--a2-text-sm); }
  .a2-form-error { padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-sm); color: var(--a2-red); font-size: var(--a2-text-sm); }
  .a2-empty { display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-8); text-align: center; color: var(--a2-text-muted); }
  .a2-empty h3 { margin: 0; font-size: var(--a2-text-base); color: var(--a2-text); }
  .a2-empty p { margin: 0; font-size: var(--a2-text-sm); max-width: 420px; }
  .a2-category-list { display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .a2-category-row { display: flex; justify-content: space-between; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-3) var(--a2-space-4); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); }
  .a2-category-row[data-enabled="false"] { opacity: 0.6; }
  .a2-category-row-main { display: flex; align-items: center; gap: var(--a2-space-3); min-width: 0; }
  .a2-category-row-icon { font-size: 20px; }
  .a2-category-row-info { min-width: 0; }
  .a2-category-row-name { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); }
  .a2-category-row-meta { display: flex; gap: var(--a2-space-1); font-size: var(--a2-text-2xs); color: var(--a2-text-muted); flex-wrap: wrap; }
  .a2-category-row-actions { display: flex; align-items: center; gap: var(--a2-space-1); flex-shrink: 0; }
  .a2-icon-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); background: var(--a2-surface-3); color: var(--a2-text-muted); cursor: pointer; }
  .a2-icon-btn:hover { color: var(--a2-cyan); border-color: var(--a2-cyan-border); }
  .a2-icon-btn-danger:hover { color: var(--a2-red); border-color: var(--a2-red-border); }
  .a2-features { display: flex; flex-direction: column; gap: var(--a2-space-3); }
  .a2-features-section-title { display: inline-flex; align-items: center; gap: var(--a2-space-2); margin: 0; font-size: var(--a2-text-sm); font-weight: 700; color: var(--a2-text-bright); }
  .a2-features-desc { margin: 0; font-size: var(--a2-text-sm); color: var(--a2-text-muted); }
  .a2-features-loading { display: inline-flex; align-items: center; gap: var(--a2-space-2); color: var(--a2-text-muted); }
  .a2-features-error { display: inline-flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-sm); color: var(--a2-red); font-size: var(--a2-text-sm); }
  .a2-features-retry { padding: 8px 12px; background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-xs); color: var(--a2-text); font-size: var(--a2-text-2xs); cursor: pointer; min-height: 44px; }
  .a2-features-success { display: inline-flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-green-soft); border: 1px solid var(--a2-green-border); border-radius: var(--a2-radius-sm); color: var(--a2-green); font-size: var(--a2-text-sm); }
  .a2-feature-row { display: flex; justify-content: space-between; align-items: center; gap: var(--a2-space-4); padding: var(--a2-space-3) var(--a2-space-4); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); }
  .a2-feature-row-info { display: flex; flex-direction: column; gap: 2px; }
  .a2-feature-row-label { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); }
  .a2-feature-row-desc { font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }
  .a2-toggle { background: transparent; border: none; cursor: pointer; color: var(--a2-text-dim); min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; }
  .a2-toggle.is-on { color: var(--a2-green); }
  .a2-toggle:disabled { opacity: 0.5; }
  .a2-crud-form { display: flex; flex-direction: column; gap: var(--a2-space-4); }
  .a2-field { display: flex; flex-direction: column; gap: 2px; }
  .a2-field span { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .a2-field input { background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-sm); padding: 6px 10px; }
  .a2-field input:focus { outline: none; border-color: var(--a2-cyan); }
  .a2-form-actions { display: flex; gap: var(--a2-space-2); justify-content: flex-end; padding-top: var(--a2-space-3); border-top: 1px solid var(--a2-border); }
  .a2-btn-primary { padding: 10px 16px; background: var(--a2-cyan); color: var(--a2-surface-1); border: none; border-radius: var(--a2-radius-sm); font-size: var(--a2-text-sm); font-weight: 600; cursor: pointer; min-height: 44px; }
  .a2-btn-secondary { padding: 10px 16px; background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-sm); font-weight: 600; cursor: pointer; min-height: 44px; }
  .mono { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); }
  @keyframes a2-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  @media (max-width: 768px) { .a2-category-row { flex-direction: column; align-items: stretch; } .a2-category-row-actions { justify-content: flex-end; } }
  @media (prefers-reduced-motion: reduce) { .a2-toggle, .a2-icon-btn { transition: none; } }
</style>
