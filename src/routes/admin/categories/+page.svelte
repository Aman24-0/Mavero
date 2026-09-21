<script lang="ts">
  import { Check, ChevronDown, Layers3, Plus, Trash2, X } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
  import AdminSection from '$lib/components/admin/AdminSection.svelte';
  import AdminEmptyState from '$lib/components/admin/AdminEmptyState.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const assignedFor = (categoryId: string) => data.sourceCategories.filter((mapping) => mapping.category_id === categoryId).sort((a, b) => a.ordering - b.ordering);
  const sourceName = (sourceId: string) => data.sources.find((source) => source.id === sourceId)?.name ?? 'Missing source';
</script>

<svelte:head><title>Category Registry — Mavero</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<AdminShell active="categories">
  <AdminPageHeader
    eyebrow="MAVERO / Category registry"
    title="Source"
    accent="categories."
    description="Create public configuration groups and persist source ordering independently inside each category."
    count={`${data.categories.length} records`}
  />

  {#if data.notice}<div class="notice" role="status"><Check size={15} /> {data.notice}</div>{/if}
  {#if form?.message}<div class="error" role="alert">{form.message}</div>{/if}

  <AdminSection variant="info">
    <details class="form-panel" open={data.categories.length === 0}>
      <summary><span class="summary-label"><Plus size={15} /> Add category</span><ChevronDown size={16} /></summary>
      <form method="POST" action="?/createCategory" class="registry-form">
        <div class="form-grid three">
          <label>Name<input name="name" required maxlength="120" placeholder="Original audio" /></label>
          <label>Slug<input name="slug" required maxlength="120" placeholder="original-audio" /></label>
          <label>Ordering<input name="ordering" type="number" min="0" step="1" value="0" /></label>
        </div>
        <label class="check"><input type="checkbox" name="enabled" checked /> Enabled for public config</label>
        <label>Description<textarea name="description" maxlength="500" rows="2" placeholder="Safe display description."></textarea></label>
        <div class="form-actions"><button class="btn btn-primary" type="submit"><Plus size={14} /> Create category</button></div>
      </form>
    </details>
  </AdminSection>

  {#if data.categories.length === 0}
    <AdminEmptyState
      icon={Layers3}
      title="No categories yet"
      message="Categories are database records and are not hardcoded in the public UI."
    />
  {:else}
    <div class="registry-list">
      {#each data.categories as category (category.id)}
        <details class="record">
          <summary>
            <div class="record-main">
              <span class="category-icon">{String(category.ordering).padStart(2, '0')}</span>
              <div class="record-copy">
                <strong>{category.name}</strong>
                <span class="record-sub">{category.slug} · {assignedFor(category.id).length} source assignments</span>
              </div>
            </div>
            <div class="record-meta">
              <AdminStatusBadge
                label={category.enabled ? 'Enabled' : 'Disabled'}
                tone={category.enabled ? 'good' : 'neutral'}
              />
              <ChevronDown size={15} />
            </div>
          </summary>
          <form method="POST" action="?/updateCategory" class="registry-form compact">
            <input type="hidden" name="id" value={category.id} />
            <div class="form-grid three">
              <label>Name<input name="name" required maxlength="120" value={category.name} /></label>
              <label>Slug<input name="slug" required maxlength="120" value={category.slug} /></label>
              <label>Ordering<input name="ordering" type="number" min="0" step="1" value={category.ordering} /></label>
            </div>
            <label class="check"><input type="checkbox" name="enabled" checked={category.enabled} /> Enabled for public config</label>
            <label>Description<textarea name="description" maxlength="500" rows="2">{category.description ?? ''}</textarea></label>
            <div class="form-actions"><button class="btn btn-primary" type="submit">Save changes</button></div>
          </form>

          <div class="assignment-panel">
            <div class="assignment-head">
              <div>
                <div class="eyebrow">Category membership</div>
                <h3>Assign sources</h3>
              </div>
              <span class="hint">Ordering is category-specific</span>
            </div>
            <form method="POST" action="?/assignSource" class="assign-form">
              <input type="hidden" name="category_id" value={category.id} />
              <select name="source_id" required>
                <option value="" disabled selected>Select a source</option>
                {#each data.sources as source}
                  <option value={source.id}>{source.name}</option>
                {/each}
              </select>
              <input name="ordering" type="number" min="0" step="1" value={assignedFor(category.id).length} aria-label="Source ordering" />
              <button class="btn btn-secondary" type="submit"><Plus size={14} /> Assign</button>
            </form>
            {#if assignedFor(category.id).length === 0}
              <p class="assignment-empty">No sources assigned to this category yet.</p>
            {:else}
              <div class="assignment-list">
                {#each assignedFor(category.id) as mapping (mapping.source_id)}
                  <div class="assignment-row">
                    <span class="order">{String(mapping.ordering).padStart(2, '0')}</span>
                    <strong>{sourceName(mapping.source_id)}</strong>
                    <form method="POST" action="?/removeSource" class="inline-form">
                      <input type="hidden" name="source_id" value={mapping.source_id} />
                      <input type="hidden" name="category_id" value={category.id} />
                      <button class="icon-btn" type="submit" aria-label={`Remove ${sourceName(mapping.source_id)}`}><X size={14} /></button>
                    </form>
                  </div>
                {/each}
              </div>
            {/if}
          </div>

          <div class="form-actions secondary-actions">
            <form method="POST" action="?/toggleCategory" class="inline-form">
              <input type="hidden" name="id" value={category.id} />
              <input type="hidden" name="enabled" value={category.enabled ? 'false' : 'true'} />
              <button class="btn btn-secondary" type="submit">{category.enabled ? 'Disable' : 'Enable'}</button>
            </form>
            <form method="POST" action="?/deleteCategory" class="inline-form" onsubmit={() => confirm(`Delete ${category.name}? Assigned sources must be removed first.`)}>
              <input type="hidden" name="id" value={category.id} />
              <button class="btn btn-danger" type="submit"><Trash2 size={14} /> Delete</button>
            </form>
          </div>
        </details>
      {/each}
    </div>
  {/if}
</AdminShell>

<style>
  .notice, .error { display: flex; align-items: center; gap: 8px; margin-top: 18px; padding: 11px 13px; border-radius: var(--radius-sm); font-size: .72rem; }
  .notice { color: var(--color-primary); border: 1px solid var(--color-primary-border); background: rgba(0, 255, 156, .06); }
  .error { color: var(--color-danger); border: 1px solid rgba(255, 77, 109, .25); background: rgba(255, 77, 109, .07); }

  .form-panel { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: rgba(0, 255, 156, .015); overflow: hidden; }
  summary { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 16px 18px; cursor: pointer; list-style: none; color: var(--color-text); font-size: .8rem; }
  summary::-webkit-details-marker { display: none; }
  .summary-label { display: inline-flex; align-items: center; gap: 8px; color: var(--color-primary); font-weight: 700; }
  .registry-form { display: grid; gap: 13px; padding: 0 18px 18px; }
  .registry-form.compact { padding-top: 14px; border-top: 1px solid var(--color-border); }
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

  .form-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .secondary-actions { padding: 0 18px 16px; }
  .btn { display: inline-flex; align-items: center; gap: 7px; min-height: 40px; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); padding: 0 14px; cursor: pointer; color: var(--color-text); background: var(--color-primary-soft); font: inherit; font-size: .74rem; font-weight: 700; transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out); }
  .btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .btn-primary { border-color: transparent; color: #050708; background: var(--color-primary); box-shadow: 0 4px 18px rgba(0, 255, 156, .22), var(--glow-primary); }
  .btn-secondary:hover { border-color: var(--color-primary-border); background: var(--color-primary-soft); box-shadow: var(--glow-primary); }
  .btn-danger { color: var(--color-danger); }
  .btn-danger:hover { border-color: rgba(255, 77, 109, .45); background: rgba(255, 77, 109, .08); }
  .inline-form { display: inline-flex; padding: 0; }

  .registry-list { display: grid; gap: 12px; margin-top: 16px; }
  .record { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); overflow: hidden; transition: border-color var(--motion-fast) var(--ease-out); }
  .record[open] { border-color: var(--color-primary-border); box-shadow: var(--glow-primary); }
  .record summary { padding: 14px 16px; }
  .category-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; color: var(--color-primary); background: var(--color-primary-soft); border: 1px solid var(--color-primary-border); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .58rem; font-weight: 700; flex: 0 0 auto; }
  .record-main { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1; }
  .record-copy { min-width: 0; }
  .record-copy strong { display: block; color: var(--color-text); font-size: .82rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .record-sub { display: block; margin-top: 3px; color: var(--color-text-deep); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .56rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .record-meta { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }

  .assignment-panel { margin: 0 18px 18px; padding: 16px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: rgba(0, 255, 156, .012); }
  .assignment-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 14px; }
  .assignment-head h3 { margin: 6px 0 0; color: var(--color-text); font-size: .85rem; font-weight: 700; }
  .hint { color: var(--color-text-deep); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .56rem; letter-spacing: .04em; }
  .assign-form { display: grid; grid-template-columns: minmax(0, 1fr) 95px auto; gap: 8px; margin-top: 13px; }
  .assign-form select, .assign-form input { min-height: 40px; }
  .assignment-list { display: grid; gap: 6px; margin-top: 12px; }
  .assignment-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); color: var(--color-text-muted); font-size: .72rem; background: var(--color-surface-elevated); }
  .assignment-row strong { flex: 1; color: var(--color-text); font-weight: 600; }
  .order { color: var(--color-primary); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .56rem; font-weight: 700; }
  .icon-btn { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); color: var(--color-text-deep); background: transparent; cursor: pointer; transition: color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out); }
  .icon-btn:hover { color: var(--color-danger); border-color: rgba(255, 77, 109, .35); }
  .icon-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .assignment-empty { margin: 13px 0 0; color: var(--color-text-deep); font-size: .68rem; }

  @media (max-width: 700px) {
    .form-grid.three { grid-template-columns: 1fr; }
    .assign-form { grid-template-columns: 1fr; }
    .assignment-head { flex-direction: column; align-items: flex-start; gap: 5px; }
    .record-meta { gap: 4px; }
  }
</style>
