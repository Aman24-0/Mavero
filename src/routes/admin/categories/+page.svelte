<script lang="ts">
  import { Check, ChevronDown, Layers3, Plus, Trash2, X } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import type { ActionData, PageData } from './$types';

  export let data: PageData;
  export let form: ActionData;

  const assignedFor = (categoryId: string) => data.sourceCategories.filter((mapping) => mapping.category_id === categoryId).sort((a, b) => a.ordering - b.ordering);
  const sourceName = (sourceId: string) => data.sources.find((source) => source.id === sourceId)?.name ?? 'Missing source';
</script>

<svelte:head><title>Category Registry — Mavero</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<AdminShell active="categories">
  <div class="eyebrow">MAVERO / Category registry</div>
  <div class="heading-row"><div><h1>Source <em>categories.</em></h1><p class="intro">Create public configuration groups and persist source ordering independently inside each category.</p></div><span class="count">{data.categories.length} records</span></div>

  {#if data.notice}<div class="notice" role="status"><Check size={15} /> {data.notice}</div>{/if}
  {#if form?.message}<div class="error" role="alert">{form.message}</div>{/if}

  <details class="form-panel" open={data.categories.length === 0}>
    <summary><span><Plus size={15} /> Add category</span><ChevronDown size={16} /></summary>
    <form method="POST" action="?/createCategory" class="registry-form">
      <div class="form-grid three"><label>Name<input name="name" required maxlength="120" placeholder="Original audio" /></label><label>Slug<input name="slug" required maxlength="120" placeholder="original-audio" /></label><label>Ordering<input name="ordering" type="number" min="0" step="1" value="0" /></label></div>
      <label class="check"><input type="checkbox" name="enabled" checked /> Enabled for public config</label>
      <label>Description<textarea name="description" maxlength="500" rows="2" placeholder="Safe display description."></textarea></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit"><Plus size={14} /> Create category</button></div>
    </form>
  </details>

  {#if data.categories.length === 0}<div class="empty"><Layers3 size={22} /><h2>No categories yet</h2><p>Categories are database records and are not hardcoded in the public UI.</p></div>{:else}<div class="registry-list">{#each data.categories as category}
    <details class="record">
      <summary><div class="record-main"><span class="category-icon">{String(category.ordering).padStart(2, '0')}</span><div><strong>{category.name}</strong><span>{category.slug} · {assignedFor(category.id).length} source assignments</span></div></div><div class="record-meta"><span class:good={category.enabled} class:warning={!category.enabled}>{category.enabled ? 'Enabled' : 'Disabled'}</span><ChevronDown size={15} /></div></summary>
      <form method="POST" action="?/updateCategory" class="registry-form compact">
        <input type="hidden" name="id" value={category.id} />
        <div class="form-grid three"><label>Name<input name="name" required maxlength="120" value={category.name} /></label><label>Slug<input name="slug" required maxlength="120" value={category.slug} /></label><label>Ordering<input name="ordering" type="number" min="0" step="1" value={category.ordering} /></label></div>
        <label class="check"><input type="checkbox" name="enabled" checked={category.enabled} /> Enabled for public config</label>
        <label>Description<textarea name="description" maxlength="500" rows="2">{category.description ?? ''}</textarea></label>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save changes</button></div>
      </form>
      <div class="assignment-panel"><div class="assignment-head"><div><div class="eyebrow">Category membership</div><h3>Assign sources</h3></div><span class="hint">Ordering is category-specific</span></div>
        <form method="POST" action="?/assignSource" class="assign-form"><input type="hidden" name="category_id" value={category.id} /><select name="source_id" required><option value="" disabled selected>Select a source</option>{#each data.sources as source}<option value={source.id}>{source.name}</option>{/each}</select><input name="ordering" type="number" min="0" step="1" value={assignedFor(category.id).length} aria-label="Source ordering" /><button class="btn btn-secondary" type="submit"><Plus size={14} /> Assign</button></form>
        {#if assignedFor(category.id).length === 0}<p class="assignment-empty">No sources assigned to this category yet.</p>{:else}<div class="assignment-list">{#each assignedFor(category.id) as mapping}<div class="assignment-row"><span class="order">{String(mapping.ordering).padStart(2, '0')}</span><strong>{sourceName(mapping.source_id)}</strong><form method="POST" action="?/removeSource" class="inline-form"><input type="hidden" name="source_id" value={mapping.source_id} /><input type="hidden" name="category_id" value={category.id} /><button class="icon-btn" type="submit" aria-label={`Remove ${sourceName(mapping.source_id)}`}><X size={14} /></button></form></div>{/each}</div>{/if}
      </div>
      <div class="form-actions secondary-actions"><form method="POST" action="?/toggleCategory" class="inline-form"><input type="hidden" name="id" value={category.id} /><input type="hidden" name="enabled" value={category.enabled ? 'false' : 'true'} /><button class="btn btn-secondary" type="submit">{category.enabled ? 'Disable' : 'Enable'}</button></form><form method="POST" action="?/deleteCategory" class="inline-form" onsubmit={() => confirm(`Delete ${category.name}? Assigned sources must be removed first.`)}><input type="hidden" name="id" value={category.id} /><button class="btn btn-danger" type="submit"><Trash2 size={14} /> Delete</button></form></div>
    </details>
  {/each}</div>{/if}
</AdminShell>

<style>
  em { color: var(--accent); font-style: normal; }
  .heading-row { display: flex; align-items: end; justify-content: space-between; gap: 20px; } h1 { margin: 8px 0 9px; font-size: clamp(2rem, 5vw, 3.7rem); letter-spacing: -.08em; } .intro { max-width: 650px; margin: 0; color: var(--muted); font-size: .78rem; line-height: 1.65; } .count, .hint { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .58rem; }
  .notice, .error { display: flex; align-items: center; gap: 8px; margin-top: 18px; padding: 11px 13px; border-radius: 9px; font-size: .72rem; } .notice { color: var(--success); border: 1px solid rgba(126,220,180,.2); background: rgba(126,220,180,.06); } .error { color: #e6b6a4; border: 1px solid rgba(228,133,105,.25); background: rgba(228,133,105,.07); }
  .form-panel, .record { margin-top: 19px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); } summary { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 17px 19px; cursor: pointer; list-style: none; color: var(--ink); font-size: .8rem; } summary::-webkit-details-marker { display: none; } summary > span, .record-main, .record-meta { display: flex; align-items: center; gap: 9px; } summary > span { color: var(--accent); }
  .registry-form { display: grid; gap: 13px; padding: 0 19px 19px; } .registry-form.compact { padding-top: 0; border-top: 1px solid var(--line); } .form-grid { display: grid; gap: 10px; } .form-grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); } label { display: grid; gap: 6px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .57rem; } input, select, textarea { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 10px 11px; color: var(--ink); background: rgba(255,255,255,.035); font: inherit; font-family: inherit; font-size: .68rem; outline: none; } input:focus, select:focus, textarea:focus { border-color: rgba(155,135,245,.7); box-shadow: 0 0 0 3px rgba(155,135,245,.1); } textarea { resize: vertical; line-height: 1.5; } .check { display: flex; align-items: center; gap: 8px; min-height: 38px; } .check input { width: auto; accent-color: var(--accent); }
  .form-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; } .secondary-actions { padding: 0 19px 16px; } .btn { display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; cursor: pointer; color: var(--ink); background: transparent; font: inherit; font-size: .66rem; } .btn-primary { border-color: transparent; color: #101014; background: var(--ink); } .btn-secondary:hover { border-color: rgba(155,135,245,.45); background: var(--accent-soft); } .btn-danger { color: #e6b6a4; } .inline-form { display: inline-flex; padding: 0; }
  .registry-list { display: grid; gap: 10px; margin-top: 15px; } .record { margin-top: 0; } .record summary { padding: 14px 16px; } .category-icon { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; color: var(--accent); background: var(--accent-soft); font-family: 'DM Mono', monospace; font-size: .58rem; } .record-main strong { display: block; color: var(--ink); font-size: .78rem; } .record-main span:not(.category-icon) { display: block; margin-top: 3px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .54rem; } .record-meta { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .55rem; } .record-meta .good { color: var(--success); } .record-meta .warning { color: #d4b27c; }
  .assignment-panel { margin: 0 19px 18px; padding: 15px; border: 1px solid var(--line); border-radius: 10px; background: rgba(255,255,255,.02); } .assignment-head { display: flex; align-items: end; justify-content: space-between; gap: 15px; } .assignment-head h3 { margin: 7px 0 0; font-size: .85rem; } .assign-form { display: grid; grid-template-columns: minmax(0, 1fr) 95px auto; gap: 8px; margin-top: 13px; } .assignment-list { display: grid; gap: 5px; margin-top: 12px; } .assignment-row { display: flex; align-items: center; gap: 10px; padding: 8px 9px; border: 1px solid var(--line); border-radius: 7px; color: var(--muted); font-size: .68rem; } .assignment-row strong { flex: 1; color: var(--ink); font-weight: 500; } .order { color: var(--accent); font-family: 'DM Mono', monospace; font-size: .56rem; } .icon-btn { display: grid; place-items: center; width: 26px; height: 26px; border: 1px solid var(--line); border-radius: 6px; color: var(--muted-deep); background: transparent; cursor: pointer; } .icon-btn:hover { color: #e6b6a4; border-color: rgba(228,133,105,.35); } .assignment-empty { margin: 13px 0 0; color: var(--muted-deep); font-size: .66rem; } .empty { margin-top: 15px; padding: 45px 20px; text-align: center; border: 1px dashed var(--line); border-radius: 14px; } .empty h2 { margin: 10px 0 5px; font-size: 1rem; } .empty p { margin: 0; color: var(--muted); font-size: .72rem; }
  @media (max-width: 700px) { .heading-row { align-items: start; flex-direction: column; } .form-grid.three, .assign-form { grid-template-columns: 1fr; } .record-meta span { display: none; } .assignment-head { align-items: start; flex-direction: column; gap: 5px; } }
</style>
