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
  import { enhance } from '$app/forms';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminStatus from '$lib/components/admin2/AdminStatus.svelte';
  import AdminSheet from '$lib/components/admin/AdminSheet.svelte';
  import AdminFormSection from '$lib/components/admin/AdminFormSection.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import AdminAddButton from '$lib/components/admin/AdminAddButton.svelte';
  import { Layers, ExternalLink, Check, AlertCircle, Loader2, ShieldCheck, ToggleLeft, ToggleRight, Plus, Edit3, Trash2, Power, X } from 'lucide-svelte';
  // 2026-10-16 round (Issue 5): ONE shared bulk-reposition validation
  // contract for every Admin ordering list (the interactive behavior can
  // never drift between surfaces; the server re-validates authoritatively).
  import { validateRepositionSet, repositionDraftFromEntries, repositionDraftIsDirty } from '$lib/shared/bulk-reposition';
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
  // MAVP-6 (Issue 4): the sheet tracks the CATEGORY ID, and the live category
  // object is derived from data — after an assign/remove/reorder action the
  // load reruns and the sheet's source-management section reflects the fresh
  // mapping rows without closing or going stale.
  let editingCategoryId: string | null = $state(null);
  const editingCategory = $derived(
    editingCategoryId ? ((data.categories as any[]).find((candidate) => candidate.id === editingCategoryId) ?? null) : null,
  );

  function openCreateCategory(event?: Event) { editingCategoryId = null; categorySheetOpen = true; }
  function openEditCategory(cat: any, event?: Event) { editingCategoryId = cat?.id ?? null; categorySheetOpen = true; }
  function closeCategorySheet() { categorySheetOpen = false; editingCategoryId = null; }

  // --- MAVP-6 (Issue 4): category source management ---
  // The authoritative data is the EXISTING load payload (sources +
  // sourceCategories mapping rows) — no second data model. A mapping row
  // whose source no longer exists (stale/deleted) renders as 'Unknown
  // source' and can still be removed (the remove form carries the mapping's
  // own source_id).
  type AssignedSourceRow = { sourceId: string; name: string; status: string | null; enabled: boolean | null; position: number };

  function assignedSourcesForCategory(categoryId: string): AssignedSourceRow[] {
    const rows = (data.sourceCategories as any[])
      .filter((sc) => sc.category_id === categoryId)
      .slice()
      .sort((a, b) => (a.ordering ?? 0) - (b.ordering ?? 0));
    return rows.map((mapping, index) => {
      const source = (data.sources as any[]).find((candidate) => candidate.id === mapping.source_id) ?? null;
      return {
        sourceId: mapping.source_id,
        name: source?.name ?? 'Unknown source',
        status: source?.status ?? null,
        enabled: source?.enabled ?? null,
        position: index + 1,
      };
    });
  }

  /** MAVP-7 (Issue 3): a source may live in AT MOST ONE category. The assign
   *  picker therefore offers ONLY sources with ZERO category assignments
   *  anywhere — a source assigned to ANOTHER category is just as unavailable
   *  as one assigned to the category being edited. The service layer
   *  re-validates authoritatively (rejects any already-assigned source, and
   *  the DB-level unique(source_id) constraint closes the concurrent-assign
   *  race), so a stale client list can never produce a double assignment. */
  function assignableSourcesForCategory(categoryId: string): any[] {
    void categoryId; // the rule is GLOBAL — kept for call-site symmetry
    const assignedAnywhere = new Set((data.sourceCategories as any[]).map((sc) => sc.source_id));
    return (data.sources as any[]).filter((candidate) => !assignedAnywhere.has(candidate.id));
  }

  // MAVP-7 (Issue 2): the per-row position workflow was REPLACED (2026-10-16
  // round, Issue 5) by the UNIFIED BULK REPOSITION editor shared with the
  // other Admin ordering lists:
  //   * Normal mode shows the saved order with ONE clear “Reposition”
  //     action (the redundant per-row position+Apply forms are gone).
  //   * Reposition mode prefills EVERY numeric input with that item's
  //     currently saved position (never blank, never auto-renumbered), and
  //     the complete proposed set is validated LIVE on every keystroke via
  //     the shared helper (blank / zero / negative / decimal / non-numeric /
  //     duplicate / out-of-range values mark the field red immediately and
  //     disable Apply — a duplicate never waits for a page reload or a
  //     database error).
  //   * Apply submits the COMPLETE intended ordering in ONE request
  //     (ordered_source_ids → reorderSourcesBulk → the ATOMIC
  //     reorder_category_sources RPC). The service re-validates the set
  //     against the database's real assignments server-side; there is no
  //     partially applied order when a write fails.
  //   * use:enhance keeps the admin on the same page — no full-document
  //     reload, the category sheet stays open, unsaved sheet state is
  //     preserved; duplicate submissions are prevented while in flight.
  //   * Cancel discards ONLY the unsaved position edits and returns to
  //     normal mode.

  // --- Bulk reposition: the category's assigned sources (sheet) ---
  let sourcesRepositioning = $state(false);
  let sourceDrafts = $state<Record<string, string>>({});
  let sourceReorderSaving = $state(false);

  const sourceRepositionEntries = $derived(
    editingCategory
      ? assignedSourcesForCategory(editingCategory.id).map((row) => ({ id: row.sourceId, savedPosition: row.position }))
      : [],
  );
  // Dense 1..N contract: positions must stay within the list length.
  const sourceRepositionValidation = $derived(
    sourcesRepositioning
      ? validateRepositionSet(sourceRepositionEntries, sourceDrafts, { maxPosition: sourceRepositionEntries.length })
      : null,
  );
  const sourceRepositionDirty = $derived(sourcesRepositioning && repositionDraftIsDirty(sourceRepositionEntries, sourceDrafts));

  function startSourcesReposition() {
    // Prefill from the SAVED positions — never blank, never renumbered.
    sourceDrafts = repositionDraftFromEntries(sourceRepositionEntries);
    sourcesRepositioning = true;
  }
  function cancelSourcesReposition() {
    // Discards ONLY the unsaved position edits.
    sourcesRepositioning = false;
    sourceDrafts = {};
  }

  // --- Bulk reposition: the GLOBAL category ordering (categories tab) ---
  let categoriesRepositioning = $state(false);
  let categoryDrafts = $state<Record<string, string>>({});
  let categoryReorderSaving = $state(false);

  const categoryRepositionEntries = $derived(
    (data.categories as any[])
      .slice()
      .sort((a, b) => (a.ordering ?? 0) - (b.ordering ?? 0))
      .map((cat) => ({ id: cat.id, savedPosition: cat.ordering ?? 0 })),
  );
  // Global ordering contract: gaps permitted, values may start at 0 (the
  // prefill shows the SAVED values verbatim — never silently renumbered).
  const categoryRepositionValidation = $derived(
    categoriesRepositioning
      ? validateRepositionSet(categoryRepositionEntries, categoryDrafts, { minPosition: 0 })
      : null,
  );
  const categoryRepositionDirty = $derived(categoriesRepositioning && repositionDraftIsDirty(categoryRepositionEntries, categoryDrafts));

  function startCategoriesReposition() {
    categoryDrafts = repositionDraftFromEntries(categoryRepositionEntries);
    categoriesRepositioning = true;
  }
  function cancelCategoriesReposition() {
    categoriesRepositioning = false;
    categoryDrafts = {};
  }

  function statusTone(status: string | null): 'good' | 'warn' | 'bad' | 'neutral' {
    if (status === 'active' || status === 'experimental') return 'good';
    if (status === 'maintenance') return 'warn';
    return 'neutral';
  }

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
        <!-- 2026-10-16 round (Issue 5): unified BULK REPOSITION for the global
             category ordering. Normal mode shows the saved order with ONE
             “Reposition” action; reposition mode prefills every input with
             the SAVED value and validates the complete set live (the shared
             helper) — Apply stays disabled while any value is invalid, and
             the enhanced submission updates the list in place (no
             full-page reload). -->
        {#if categoriesRepositioning}
          <form
            method="POST"
            action="?/reorderCategories"
            class="a2-reposition-bar"
            use:enhance={() => {
              categoryReorderSaving = true;
              return async ({ update, result }) => {
                await update({ reset: false });
                categoryReorderSaving = false;
                // Only a CONFIRMED success exits reposition mode — a failed
                // save keeps the admin's unsaved edits visible + fixable.
                if (result.type === 'success' || result.type === 'redirect') {
                  categoriesRepositioning = false;
                  categoryDrafts = {};
                }
              };
            }}
          >
            <p class="a2-reposition-hint">Edit the numbers to reposition. Every value is validated live — Apply stays disabled until the whole set is valid. Cancel discards unsaved edits.</p>
            {#if categoryRepositionValidation?.setError}
              <p class="a2-reposition-error" role="alert"><AlertCircle size={13} /> {categoryRepositionValidation.setError}</p>
            {/if}
            <div class="a2-assigned-list">
              {#each categoryRepositionEntries as entry (entry.id)}
                {@const cat = (data.categories as any[]).find((c) => c.id === entry.id)}
                {@const rowError = categoryRepositionValidation?.errors[entry.id] ?? null}
                <div class="a2-assigned-row">
                  <label class="a2-position-field">
                    <span>Position</span>
                    <input type="number" name={`ordering_${entry.id}`} value={categoryDrafts[entry.id] ?? String(entry.savedPosition)} min="0" step="1" inputmode="numeric" class:invalid={Boolean(rowError)} aria-invalid={rowError ? 'true' : undefined} aria-label={`Position for ${cat?.name ?? 'category'}`} oninput={(e) => { categoryDrafts = { ...categoryDrafts, [entry.id]: (e.currentTarget as HTMLInputElement).value }; }} />
                  </label>
                  <span class="a2-assigned-name">{cat?.name ?? 'Unknown category'}</span>
                  <AdminStatusBadge label={cat?.enabled ? 'Enabled' : 'Disabled'} tone={cat?.enabled ? 'good' : 'neutral'} />
                  {#if rowError}<span class="a2-position-row-error" role="alert">{rowError}</span>{/if}
                </div>
              {/each}
            </div>
            <div class="a2-form-actions">
              <button type="submit" class="a2-btn-primary" disabled={!categoryRepositionValidation?.valid || !categoryRepositionDirty || categoryReorderSaving}>{categoryReorderSaving ? 'Saving…' : 'Apply'}</button>
              <button type="button" class="a2-btn-secondary" onclick={cancelCategoriesReposition} disabled={categoryReorderSaving}>Cancel</button>
            </div>
          </form>
        {:else}
          <div class="a2-reposition-bar">
            <button type="button" class="a2-btn-secondary a2-reposition-trigger" onclick={startCategoriesReposition}>Reposition</button>
          </div>
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
                  <form method="POST" action="?/deleteCategory" style="display:inline" onsubmit={(e) => { if (!confirm('Delete this category? This cannot be undone.')) e.preventDefault(); }}>
                    <input type="hidden" name="id" value={cat.id} />
                    <button type="submit" class="a2-icon-btn a2-icon-btn-danger" title="Delete"><Trash2 size={14} /></button>
                  </form>
                </div>
              </div>
            {/each}
          </div>
        {/if}
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
    <div class="a2-crud-form">
      <form method="POST" action={editingCategory ? '?/updateCategory' : '?/createCategory'} use:enhance={() => {
        return async ({ update }) => { await update({ reset: false }); };
      }}>
        {#if editingCategory}<input type="hidden" name="id" value={editingCategory.id} />{/if}
        <AdminFormSection heading="Identity">
          <label class="a2-field"><span>Name</span><input name="name" required value={editingCategory?.name ?? ''} /></label>
          <label class="a2-field"><span>Slug</span><input name="slug" required value={editingCategory?.slug ?? ''} /></label>
          <!-- FINDING-007 fix: removed dead Icon emoji input. streaming_categories has no icon column. -->

          <!-- 2026-10-16 round (Issue 5): the individual Ordering field was
               REMOVED from this sheet — the authoritative workflow is the
               bulk reposition editor on the category list (one ordering
               system, one control). The server omits an absent ordering key
               on update, so saving unrelated category fields can never
               change the saved ordering. -->
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

      {#if editingCategory}
        <!-- 2026-10-16 round (Issue 5): category source management — a
             SEPARATE section with its own forms (never nested inside the
             category form). The per-row position+Apply controls were
             REPLACED by the unified BULK reposition workflow (one
             “Reposition” action; prefilled saved positions; live shared
             validation; ONE request carrying the complete intended order;
             atomic RPC persistence; enhanced submission → no full-page
             reload, this sheet stays open). Assign/remove are also enhanced
             in-place mutations. -->
        <AdminFormSection heading="Sources in this category">
          {#if sourcesRepositioning && sourceRepositionEntries.length > 0}
            <form
              method="POST"
              action="?/reorderSourcesBulk"
              class="a2-reposition-form"
              use:enhance={() => {
                sourceReorderSaving = true;
                return async ({ update, result }) => {
                  await update({ reset: false });
                  sourceReorderSaving = false;
                  // Only a CONFIRMED success exits reposition mode — a
                  // failed save keeps the admin's unsaved edits visible.
                  if (result.type === 'success' || result.type === 'redirect') {
                    sourcesRepositioning = false;
                    sourceDrafts = {};
                  }
                };
              }}
            >
              <input type="hidden" name="category_id" value={editingCategory.id} />
              {#if sourceRepositionValidation?.valid}
                {#each sourceRepositionValidation.orderedIds as orderedId (orderedId)}
                  <input type="hidden" name="ordered_source_ids" value={orderedId} />
                {/each}
              {/if}
              <p class="a2-field-hint">Edit the numbers to reposition (1 = first). Values are validated live — Apply stays disabled until the whole set is valid. Cancel discards unsaved edits.</p>
              {#if sourceRepositionValidation?.setError}
                <p class="a2-reposition-error" role="alert"><AlertCircle size={13} /> {sourceRepositionValidation.setError}</p>
              {/if}
              <div class="a2-assigned-list">
                {#each sourceRepositionEntries as entry (entry.id)}
                  {@const row = assignedSourcesForCategory(editingCategory.id).find((candidate) => candidate.sourceId === entry.id)}
                  {@const rowError = sourceRepositionValidation?.errors[entry.id] ?? null}
                  <div class="a2-assigned-row">
                    <label class="a2-position-field">
                      <span>Position</span>
                      <input type="number" value={sourceDrafts[entry.id] ?? String(entry.savedPosition)} min="1" max={sourceRepositionEntries.length} step="1" inputmode="numeric" class:invalid={Boolean(rowError)} aria-invalid={rowError ? 'true' : undefined} aria-label={`Position for ${row?.name ?? 'source'}`} oninput={(e) => { sourceDrafts = { ...sourceDrafts, [entry.id]: (e.currentTarget as HTMLInputElement).value }; }} />
                    </label>
                    <span class="a2-assigned-name">{row?.name ?? 'Unknown source'}</span>
                    {#if row?.enabled === false}
                      <AdminStatusBadge label="Disabled" tone="neutral" />
                    {/if}
                    {#if rowError}<span class="a2-position-row-error" role="alert">{rowError}</span>{/if}
                  </div>
                {/each}
              </div>
              <div class="a2-form-actions">
                <button type="submit" class="a2-btn-primary" disabled={!sourceRepositionValidation?.valid || !sourceRepositionDirty || sourceReorderSaving}>{sourceReorderSaving ? 'Saving…' : 'Apply'}</button>
                <button type="button" class="a2-btn-secondary" onclick={cancelSourcesReposition} disabled={sourceReorderSaving}>Cancel</button>
              </div>
            </form>
          {:else}
            <p class="a2-field-hint">Assign an unassigned source to this category. Positions (1 = first) are edited through the shared Reposition workflow — nothing is persisted until you apply it there; removing never deletes the source itself.</p>
            {#if sourceRepositionEntries.length > 0}
              <div class="a2-reposition-bar">
                <button type="button" class="a2-btn-secondary a2-reposition-trigger" onclick={startSourcesReposition}>Reposition</button>
              </div>
              <div class="a2-assigned-list">
                {#each assignedSourcesForCategory(editingCategory.id) as row (row.sourceId)}
                  <div class="a2-assigned-row">
                    <span class="a2-assigned-pos">{row.position}</span>
                    <span class="a2-assigned-name">{row.name}</span>
                    <AdminStatusBadge label={row.status ?? 'unknown'} tone={statusTone(row.status)} />
                    {#if row.enabled === false}
                      <AdminStatusBadge label="Disabled" tone="neutral" />
                    {/if}
                    <span class="a2-assigned-spacer"></span>
                    <!-- In-place removal (enhanced): deletes ONLY the mapping
                         row — the source itself is never deleted — and the
                         load invalidation refreshes this sheet's list without
                         a full-page reload. -->
                    <form method="POST" action="?/removeSource" class="a2-inline-form" use:enhance={({ cancel }) => {
                      // The confirm runs in the PRE-SUBMIT phase: declining
                      // cancels the request outright (no navigation, no POST).
                      if (!confirm('Remove this source from the category? The source itself is not deleted.')) { cancel(); return; }
                      return async ({ update }) => {
                        await update({ reset: false });
                        cancelSourcesReposition();
                      };
                    }}>
                      <input type="hidden" name="category_id" value={editingCategory.id} />
                      <input type="hidden" name="source_id" value={row.sourceId} />
                      <button type="submit" class="a2-icon-btn a2-icon-btn-danger" title="Remove from category" aria-label={`Remove ${row.name} from this category`}><Trash2 size={14} /></button>
                    </form>
                  </div>
                {/each}
              </div>
            {:else}
              <p class="a2-sources-empty" role="status">No sources assigned to this category yet.</p>
            {/if}
          {/if}
          {#if assignableSourcesForCategory(editingCategory.id).length === 0}
            <p class="a2-sources-empty" role="status">No unassigned sources remain — every existing source already belongs to a category.</p>
          {:else}
            <!-- In-place assignment (enhanced): the sheet stays open, the
                 assigned list refreshes from the reloaded data, and other
                 unsaved sheet state is preserved (no document reload). -->
            <form method="POST" action="?/assignSource" class="a2-assign-row" use:enhance={() => {
              return async ({ update, formElement, result }) => {
                await update({ reset: false });
                if (result.type === 'success' || result.type === 'redirect') {
                  formElement.reset();
                  cancelSourcesReposition();
                }
              };
            }}>
              <input type="hidden" name="category_id" value={editingCategory.id} />
              <label class="a2-field a2-assign-select"><span>Assign a source</span>
                <select name="source_id" required>
                  {#each assignableSourcesForCategory(editingCategory.id) as candidate (candidate.id)}
                    <option value={candidate.id}>{candidate.name} — {candidate.status ?? 'unknown'}</option>
                  {/each}
                </select>
              </label>
              <button type="submit" class="a2-btn-secondary"><Plus size={13} /> Assign</button>
            </form>
          {/if}
        </AdminFormSection>
      {:else}
        <p class="a2-field-hint">Source assignment becomes available once the category is created — edit it afterwards to manage its sources and resolver order.</p>
      {/if}
    </div>
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
  /* MAVP-6 (Issue 4): category source-management section */
  .a2-field-hint { margin: 0; font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }
  .a2-sources-empty { margin: 0; padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-surface-2); border: 1px dashed var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text-muted); font-size: var(--a2-text-xs); }
  .a2-assigned-list { display: flex; flex-direction: column; gap: var(--a2-space-1); }
  .a2-assigned-row { display: flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-1) var(--a2-space-2); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); flex-wrap: wrap; }
  .a2-assigned-pos { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; border-radius: 999px; background: var(--a2-surface-3); color: var(--a2-text-dim); font-size: var(--a2-text-2xs); font-weight: 700; }
  .a2-assigned-name { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); }
  .a2-assigned-spacer { flex: 1 1 auto; }
  .a2-inline-form { display: inline-flex; }
  /* 2026-10-16 round (Issue 5): numeric position control (shared bulk
     reposition editor — the retired per-row Apply forms and their
     dedicated styles were removed with them). */
  .a2-position-field { display: flex; flex-direction: column; gap: 2px; }
  .a2-position-field span { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .a2-position-field input { width: 4.5rem; min-height: 44px; padding: 6px 8px; background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-sm); text-align: center; }
  .a2-position-field input:focus { outline: none; border-color: var(--a2-cyan); }
  /* 2026-10-16 round (Issue 5): unified bulk-reposition editor. */
  .a2-reposition-bar { display: flex; align-items: center; justify-content: flex-end; gap: var(--a2-space-2); margin-bottom: var(--a2-space-2); }
  .a2-reposition-trigger { min-height: 44px; }
  .a2-reposition-form { display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .a2-reposition-hint { margin: 0; font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }
  .a2-reposition-error { display: inline-flex; align-items: center; gap: var(--a2-space-1); margin: 0; padding: var(--a2-space-1) var(--a2-space-2); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-sm); color: var(--a2-red); font-size: var(--a2-text-2xs); }
  .a2-position-row-error { font-size: var(--a2-text-2xs); color: var(--a2-red); }
  .a2-position-field input.invalid { border-color: var(--a2-red); color: var(--a2-red); }
  .a2-position-field input.invalid:focus { border-color: var(--a2-red); }
  .a2-assign-row { display: flex; align-items: flex-end; gap: var(--a2-space-2); flex-wrap: wrap; }
  .a2-assign-select { flex: 1 1 220px; }
  .a2-assign-row select { background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-sm); padding: 8px 10px; min-height: 44px; }
  .a2-assign-row select:focus { outline: none; border-color: var(--a2-cyan); }
  .a2-assign-row .a2-btn-secondary { display: inline-flex; align-items: center; gap: var(--a2-space-1); }
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
