<script lang="ts">
  import { Check, ChevronRight, Layers3, Trash2, X, Plus } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
  import AdminEmptyState from '$lib/components/admin/AdminEmptyState.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import AdminAddButton from '$lib/components/admin/AdminAddButton.svelte';
  import AdminSheet from '$lib/components/admin/AdminSheet.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const assignedFor = (categoryId: string) => data.sourceCategories.filter((mapping) => mapping.category_id === categoryId).sort((a, b) => a.ordering - b.ordering);
  const sourceName = (sourceId: string) => data.sources.find((source) => source.id === sourceId)?.name ?? 'Missing source';

  // Create/Edit modal state.
  let sheetOpen = $state(false);
  let editingCategory = $state<PageData['categories'][number] | null>(null);

  function openCreate(event?: Event) {
    editingCategory = null;
    sheetOpen = true;
  }
  function openEdit(category: PageData['categories'][number], event?: Event) {
    editingCategory = category;
    sheetOpen = true;
  }
  function closeSheet() {
    sheetOpen = false;
    editingCategory = null;
  }

  // Assignment panel modal (kept as a separate sheet so the edit form
  // doesn't grow to 3× the viewport height).
  let assignSheetOpen = $state(false);
  let assignCategory = $state<PageData['categories'][number] | null>(null);

  function openAssignPanel(category: PageData['categories'][number]) {
    assignCategory = category;
    assignSheetOpen = true;
  }
  function closeAssignSheet() {
    assignSheetOpen = false;
    assignCategory = null;
  }
</script>

<svelte:head><title>Category Registry — Mavero</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<AdminShell active="categories">
  <AdminPageHeader
    eyebrow="MAVERO / Category registry"
    title="Source"
    accent="categories."
    count={`${data.categories.length} records`}
  >
    {#snippet actions()}
      <AdminAddButton label="Add category" onclick={openCreate} />
    {/snippet}
  </AdminPageHeader>

  {#if data.notice}<div class="notice" role="status"><Check size={15} /> {data.notice}</div>{/if}
  {#if form?.message}<div class="error" role="alert">{form.message}</div>{/if}

  {#if data.categories.length === 0}
    <AdminEmptyState
      icon={Layers3}
      title="No categories yet"
      message="Categories are database records and are not hardcoded in the public UI."
    />
  {:else}
    <div class="registry-list">
      {#each data.categories as category (category.id)}
        <article class="record">
          <div class="record-head" onclick={(e) => openEdit(category, e)} role="button" tabindex="0"
                 onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEdit(category, e); } }}
                 aria-label={`Edit ${category.name}`}>
            <span class="category-icon">{String(category.ordering).padStart(2, '0')}</span>
            <div class="record-copy">
              <strong class="record-name">{category.name}</strong>
              <span class="record-sub">{category.slug} · {assignedFor(category.id).length} source assignments</span>
            </div>
            <span class="record-chevron"><ChevronRight size={18} /></span>
          </div>
          <div class="record-badges">
            <AdminStatusBadge
              label={category.enabled ? 'Enabled' : 'Disabled'}
              tone={category.enabled ? 'good' : 'neutral'}
            />
            <span class="record-actions">
              <button class="mini-btn" type="button" onclick={() => openAssignPanel(category)}>Sources</button>
              <form method="POST" action="?/toggleCategory" class="inline-form">
                <input type="hidden" name="id" value={category.id} />
                <input type="hidden" name="enabled" value={category.enabled ? 'false' : 'true'} />
                <button class="mini-btn" type="submit">{category.enabled ? 'Disable' : 'Enable'}</button>
              </form>
              <form method="POST" action="?/deleteCategory" class="inline-form" onsubmit={() => confirm(`Delete ${category.name}? Assigned sources must be removed first.`)}>
                <input type="hidden" name="id" value={category.id} />
                <button class="mini-btn mini-btn-danger" type="submit" aria-label={`Delete ${category.name}`}><Trash2 size={13} /></button>
              </form>
            </span>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</AdminShell>

<!-- ============================================================
     CREATE / EDIT MODAL — same form fields, now inside AdminSheet.
     Existing server actions (?/createCategory / ?/updateCategory)
     preserved unchanged.
     ============================================================ -->
<AdminSheet
  open={sheetOpen}
  title={editingCategory ? `Edit ${editingCategory.name}` : 'Add category'}
  onClose={closeSheet}
  closeOnBackdrop={false}
>
  <form method="POST" action={editingCategory ? '?/updateCategory' : '?/createCategory'} class="registry-form">
    {#if editingCategory}
      <input type="hidden" name="id" value={editingCategory.id} />
    {/if}
    <div class="form-grid three">
      <label>Name<input name="name" required maxlength="120" placeholder="Original audio" value={editingCategory?.name ?? ''} /></label>
      <label>Slug<input name="slug" required maxlength="120" placeholder="original-audio" value={editingCategory?.slug ?? ''} /></label>
      <label>Ordering<input name="ordering" type="number" min="0" step="1" value={editingCategory?.ordering ?? 0} /></label>
    </div>
    <label class="check"><input type="checkbox" name="enabled" checked={editingCategory?.enabled ?? true} /> Enabled for public config</label>
    <label>Description<textarea name="description" maxlength="500" rows="2" placeholder="Safe display description.">{editingCategory?.description ?? ''}</textarea></label>
    <div class="sheet-actions">
      <button class="btn btn-primary" type="submit">{editingCategory ? 'Save changes' : 'Create category'}</button>
      <button class="btn btn-secondary" type="button" onclick={closeSheet}>Cancel</button>
    </div>
  </form>
</AdminSheet>

<!-- ============================================================
     ASSIGN SOURCES MODAL — opens when the user taps "Sources" on a
     category row. Lets the admin add/remove sources + ordering inside
     the category. Existing server actions (?/assignSource / ?/removeSource)
     preserved unchanged.
     ============================================================ -->
<AdminSheet
  open={assignSheetOpen}
  title={assignCategory ? `Sources · ${assignCategory.name}` : 'Sources'}
  description="Ordering is category-specific."
  onClose={closeAssignSheet}
>
  {#if assignCategory}
    <div class="assign-panel">
      <form method="POST" action="?/assignSource" class="assign-form">
        <input type="hidden" name="category_id" value={assignCategory.id} />
        <select name="source_id" required>
          <option value="" disabled selected>Select a source</option>
          {#each data.sources as source}
            <option value={source.id}>{source.name}</option>
          {/each}
        </select>
        <input name="ordering" type="number" min="0" step="1" value={assignedFor(assignCategory.id).length} aria-label="Source ordering" />
        <button class="btn btn-primary" type="submit"><Plus size={13} /> Assign</button>
      </form>
      {#if assignedFor(assignCategory.id).length === 0}
        <p class="assignment-empty">No sources assigned to this category yet.</p>
      {:else}
        <div class="assignment-list">
          {#each assignedFor(assignCategory.id) as mapping (mapping.source_id)}
            <div class="assignment-row">
              <span class="order">{String(mapping.ordering).padStart(2, '0')}</span>
              <strong>{sourceName(mapping.source_id)}</strong>
              <form method="POST" action="?/removeSource" class="inline-form">
                <input type="hidden" name="source_id" value={mapping.source_id} />
                <input type="hidden" name="category_id" value={assignCategory.id} />
                <button class="icon-btn" type="submit" aria-label={`Remove ${sourceName(mapping.source_id)}`}><X size={14} /></button>
              </form>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</AdminSheet>

<style>
  .notice, .error { display: flex; align-items: center; gap: 8px; margin-top: 12px; padding: 11px 13px; border-radius: var(--radius-sm); font-size: .72rem; }
  .notice { color: var(--color-primary); border: 1px solid var(--color-primary-border); background: rgba(0, 255, 156, .06); }
  .error { color: var(--color-danger); border: 1px solid rgba(255, 77, 109, .25); background: rgba(255, 77, 109, .07); }

  .registry-list { display: grid; gap: 10px; margin-top: 12px; }
  .record {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    overflow: hidden;
    transition: border-color var(--motion-fast) var(--ease-out);
  }
  .record:hover { border-color: var(--color-primary-border); }
  .record-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    cursor: pointer;
    min-height: 56px;
    outline: none;
  }
  .record-head:hover { background: rgba(0, 255, 156, .025); }
  .record-head:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
  .category-icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 8px;
    color: var(--color-primary);
    background: var(--color-primary-soft);
    border: 1px solid var(--color-primary-border);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .58rem;
    font-weight: 700;
    flex: 0 0 auto;
  }
  .record-copy { min-width: 0; flex: 1; }
  .record-name {
    display: block;
    color: var(--color-text);
    font-size: .86rem;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .record-sub {
    display: block;
    margin-top: 3px;
    color: var(--color-text-deep);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .56rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .record-chevron {
    display: inline-flex;
    color: var(--color-text-deep);
    flex: 0 0 auto;
    transition: color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out);
  }
  .record-head:hover .record-chevron { color: var(--color-primary); transform: translateX(2px); }

  .record-badges {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding: 0 14px 12px;
    border-top: 1px solid var(--color-border);
    padding-top: 10px;
    margin-top: 2px;
  }
  .record-actions {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    flex-wrap: nowrap;
  }
  .mini-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    min-height: 32px;
    padding: 0 11px;
    border: 1px solid var(--color-border-strong);
    border-radius: 999px;
    color: var(--color-text-muted);
    background: transparent;
    font: inherit;
    font-size: .64rem;
    font-weight: 700;
    cursor: pointer;
    transition: color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
  }
  .mini-btn:hover { color: var(--color-text); border-color: var(--color-primary-border); background: var(--color-primary-soft); }
  .mini-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .mini-btn-danger { color: var(--color-danger); border-color: rgba(255, 77, 109, .3); }
  .mini-btn-danger:hover { color: var(--color-danger); border-color: rgba(255, 77, 109, .5); background: rgba(255, 77, 109, .08); }
  .inline-form { display: inline-flex; padding: 0; }

  /* Form (inside the modal) */
  .registry-form { display: grid; gap: 13px; }
  .form-grid { display: grid; gap: 10px; }
  .form-grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  label { display: grid; gap: 6px; color: var(--color-text-muted); font-size: .58rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  input, select, textarea {
    width: 100%; box-sizing: border-box;
    min-height: 44px;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    color: var(--color-text);
    background: var(--color-surface-elevated);
    font: inherit;
    font-family: inherit;
    font-size: .78rem;
    outline: none;
    transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out);
  }
  input:focus, select:focus, textarea:focus {
    border-color: var(--color-primary);
    background: var(--color-surface-raised);
    box-shadow: var(--glow-primary);
  }
  textarea { resize: vertical; line-height: 1.55; min-height: 64px; }
  .check { display: flex; align-items: center; justify-content: flex-start; gap: 10px; min-height: 44px; padding: 10px 12px; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); background: var(--color-surface-elevated); text-transform: none; letter-spacing: 0; font-weight: 500; color: var(--color-text); font-size: .76rem; }
  .check input { width: auto; min-height: 0; accent-color: var(--color-primary); }

  .sheet-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
  .btn { display: inline-flex; align-items: center; gap: 7px; min-height: 40px; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); padding: 0 14px; cursor: pointer; color: var(--color-text); background: var(--color-primary-soft); font: inherit; font-size: .74rem; font-weight: 700; transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .btn:active { transform: scale(.98); }
  .btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .btn-primary { border-color: transparent; color: #050708; background: var(--color-primary); box-shadow: 0 4px 18px rgba(0, 255, 156, .22), var(--glow-primary); }
  .btn-primary:hover { filter: brightness(1.06); }
  .btn-secondary:hover { border-color: var(--color-primary-border); background: var(--color-primary-soft); box-shadow: var(--glow-primary); }

  /* Assign sources panel (inside its own modal) */
  .assign-panel { display: grid; gap: 14px; }
  .assign-form { display: grid; grid-template-columns: minmax(0, 1fr) 95px auto; gap: 8px; }
  .assign-form select, .assign-form input { min-height: 40px; }
  .assignment-list { display: grid; gap: 6px; }
  .assignment-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); color: var(--color-text-muted); font-size: .72rem; background: var(--color-surface-elevated); }
  .assignment-row strong { flex: 1; color: var(--color-text); font-weight: 600; }
  .order { color: var(--color-primary); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .56rem; font-weight: 700; }
  .icon-btn { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); color: var(--color-text-deep); background: transparent; cursor: pointer; transition: color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out); }
  .icon-btn:hover { color: var(--color-danger); border-color: rgba(255, 77, 109, .35); }
  .icon-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .assignment-empty { margin: 0; color: var(--color-text-deep); font-size: .68rem; }

  @media (max-width: 640px) {
    .form-grid.three, .assign-form { grid-template-columns: 1fr; }
    .record-badges { gap: 4px; }
  }
</style>
