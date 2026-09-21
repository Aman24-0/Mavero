<script lang="ts">
  import { Check, ChevronDown, Download, Plus, Star, Trash2, X } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
  import AdminSection from '$lib/components/admin/AdminSection.svelte';
  import AdminEmptyState from '$lib/components/admin/AdminEmptyState.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import type { ActionData, PageData } from './$types';
  import { slugifyTitle } from '$lib/shared/downloader';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // Live preview for the Cineverse slug when the admin is editing a
  // provider whose movie_url_template contains {titleSlug}. Purely
  // cosmetic — the actual slug is generated at runtime by the URL builder.
  function previewSlug(name: string, movieTemplate: string | null): string {
    if (!movieTemplate || !movieTemplate.includes('{titleSlug}')) return '';
    return slugifyTitle(name || 'Example Title');
  }
  function supportsMovieLabel(provider: PageData['providers'][number]): string {
    const types: string[] = [];
    if (provider.supports_movie) types.push('Movie');
    if (provider.supports_tv) types.push('TV');
    return types.length === 0 ? 'None' : types.join(' · ');
  }
</script>

<svelte:head><title>Downloader Registry — Mavero</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<AdminShell active="downloaders">
  <AdminPageHeader
    eyebrow="MAVERO / Downloader registry"
    title="Downloaders"
    accent="registry."
    description="A separate registry of download providers — independent from streaming providers/sources. HTTPS-only URL templates with known placeholders. Exactly one default at a time."
    count={`${data.providers.length} records · ${data.overview.enabledCount} enabled`}
  />

  {#if data.notice}<div class="notice" role="status"><Check size={15} /> {data.notice}</div>{/if}
  {#if form?.message}<div class="error" role="alert">{form.message}</div>{/if}

  <AdminSection variant="info">
    {#snippet actions()}
      <span class="hint">No third-party calls are made from this admin.</span>
    {/snippet}
    <details class="form-panel" open={data.providers.length === 0}>
      <summary><span class="summary-label"><Plus size={15} /> Add downloader</span><ChevronDown size={16} /></summary>
      <form method="POST" action="?/createProvider" class="registry-form">
        <div class="form-grid two">
          <label>Name<input name="name" required maxlength="120" placeholder="02Movie Downloader" /></label>
          <label>Slug<input name="slug" required maxlength="120" placeholder="02movie" /></label>
        </div>
        <div class="form-grid three">
          <label>Ordering<input name="ordering" type="number" min="0" step="1" value="0" /></label>
          <label>Icon / display token<input name="icon" maxlength="120" placeholder="download" /></label>
          <label class="check"><input type="checkbox" name="enabled" /> Enabled</label>
        </div>
        <div class="form-grid two">
          <label class="check"><input type="checkbox" name="supports_movie" checked /> Supports movie</label>
          <label class="check"><input type="checkbox" name="supports_tv" checked /> Supports TV</label>
        </div>
        <label class="check"><input type="checkbox" name="is_default" /> Set as default downloader</label>
        <label>Description<textarea name="description" maxlength="500" rows="2" placeholder="Safe display description shown to users."></textarea></label>
        <label>Movie URL template (HTTPS only)<input name="movie_url_template" maxlength="500" placeholder={'https://example.com/movie/{tmdbId}'} /></label>
        <label>TV URL template (HTTPS only)<input name="tv_url_template" maxlength="500" placeholder={'https://example.com/tv/{tmdbId}/{season}/{episode}'} /></label>
        <small class="hint">Allowed placeholders: <code>{'{' + 'tmdbId}'}</code> <code>{'{' + 'season}'}</code> <code>{'{' + 'episode}'}</code> <code>{'{' + 'season2}'}</code> <code>{'{' + 'episode2}'}</code> <code>{'{' + 'titleSlug}'}</code>. <code>{'{' + 'season2}'}</code>/<code>{'{' + 'episode2}'}</code> are zero-padded (s02e05). <code>{'{' + 'titleSlug}'}</code> is generated from the title.</small>
        <div class="form-actions"><button class="btn btn-primary" type="submit"><Plus size={14} /> Create downloader</button></div>
      </form>
    </details>
  </AdminSection>

  {#if data.providers.length === 0}
    <AdminEmptyState
      icon={Download}
      title="No downloaders yet"
      message="Create the first downloader above. It will remain disabled until explicitly enabled."
    />
  {:else}
    <div class="registry-list">
      {#each data.providers as provider (provider.id)}
        <details class="record">
          <summary>
            <div class="record-main">
              <span class="provider-icon">{provider.icon || 'DL'}</span>
              <div class="record-copy">
                <strong>{provider.name}{#if provider.is_default}<span class="default-badge"><Star size={11} fill="currentColor" strokeWidth={0} /> Default</span>{/if}</strong>
                <span class="record-sub">{provider.slug} · {supportsMovieLabel(provider)} · order {provider.ordering}</span>
              </div>
            </div>
            <div class="record-meta">
              <AdminStatusBadge
                label={provider.enabled ? 'Enabled' : 'Disabled'}
                tone={provider.enabled ? 'good' : 'neutral'}
              />
              <ChevronDown size={15} />
            </div>
          </summary>
          <form method="POST" action="?/updateProvider" class="registry-form compact">
            <input type="hidden" name="id" value={provider.id} />
            <div class="form-grid two">
              <label>Name<input name="name" required maxlength="120" value={provider.name} /></label>
              <label>Slug<input name="slug" required maxlength="120" value={provider.slug} /></label>
            </div>
            <div class="form-grid three">
              <label>Ordering<input name="ordering" type="number" min="0" step="1" value={provider.ordering} /></label>
              <label>Icon / display token<input name="icon" maxlength="120" value={provider.icon ?? ''} /></label>
              <label class="check"><input type="checkbox" name="enabled" checked={provider.enabled} /> Enabled</label>
            </div>
            <div class="form-grid two">
              <label class="check"><input type="checkbox" name="supports_movie" checked={provider.supports_movie} /> Supports movie</label>
              <label class="check"><input type="checkbox" name="supports_tv" checked={provider.supports_tv} /> Supports TV</label>
            </div>
            <label class="check"><input type="checkbox" name="is_default" checked={provider.is_default} /> Set as default downloader</label>
            <label>Description<textarea name="description" maxlength="500" rows="2">{provider.description ?? ''}</textarea></label>
            <label>Movie URL template (HTTPS only)<input name="movie_url_template" maxlength="500" value={provider.movie_url_template ?? ''} /></label>
            {#if previewSlug(provider.name, provider.movie_url_template)}
              <small class="hint">Slug preview for "{provider.name}": <code>{previewSlug(provider.name, provider.movie_url_template)}</code></small>
            {/if}
            <label>TV URL template (HTTPS only)<input name="tv_url_template" maxlength="500" value={provider.tv_url_template ?? ''} /></label>
            <div class="form-actions"><button class="btn btn-primary" type="submit">Save changes</button></div>
          </form>
          <div class="form-actions secondary-actions">
            <form method="POST" action="?/toggleProvider" class="inline-form">
              <input type="hidden" name="id" value={provider.id} />
              <input type="hidden" name="enabled" value={provider.enabled ? 'false' : 'true'} />
              <button class="btn btn-secondary" type="submit">{provider.enabled ? 'Disable' : 'Enable'}</button>
            </form>
            {#if !provider.is_default}
              <form method="POST" action="?/setDefault" class="inline-form" onsubmit={() => confirm(`Make ${provider.name} the default downloader?`)}>
                <input type="hidden" name="id" value={provider.id} />
                <button class="btn btn-secondary" type="submit"><Star size={13} /> Make default</button>
              </form>
            {/if}
            <form method="POST" action="?/deleteProvider" class="inline-form" onsubmit={() => confirm(`Delete ${provider.name}?`)}>
              <input type="hidden" name="id" value={provider.id} />
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

  .hint { color: var(--color-text-deep); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .56rem; line-height: 1.5; display: block; margin-top: 4px; }
  .hint code { color: var(--color-text); background: var(--color-surface-elevated); padding: 1px 5px; border-radius: 4px; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .54rem; }

  .form-panel { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: rgba(0, 255, 156, .015); overflow: hidden; }
  summary { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 16px 18px; cursor: pointer; list-style: none; color: var(--color-text); font-size: .8rem; }
  summary::-webkit-details-marker { display: none; }
  .summary-label { display: inline-flex; align-items: center; gap: 8px; color: var(--color-primary); font-weight: 700; }
  .registry-form { display: grid; gap: 13px; padding: 0 18px 18px; }
  .registry-form.compact { padding-top: 14px; border-top: 1px solid var(--color-border); }
  .form-grid { display: grid; gap: 10px; }
  .form-grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .form-grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  label { display: grid; gap: 6px; color: var(--color-text-muted); font-size: .58rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  input, textarea {
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
  input:focus, textarea:focus {
    border-color: var(--color-primary);
    background: var(--color-surface-raised);
    box-shadow: var(--glow-primary);
  }
  textarea { resize: vertical; line-height: 1.55; min-height: 64px; }
  .check { display: flex; align-items: center; justify-content: flex-start; gap: 10px; min-height: 44px; padding: 10px 12px; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); background: var(--color-surface-elevated); text-transform: none; letter-spacing: 0; font-weight: 500; color: var(--color-text); font-size: .76rem; }
  .check input { width: auto; min-height: 0; accent-color: var(--color-primary); }

  .form-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .secondary-actions { padding: 0 18px 16px; }
  .btn { display: inline-flex; align-items: center; gap: 7px; min-height: 40px; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); padding: 0 14px; cursor: pointer; color: var(--color-text); background: var(--color-primary-soft); font: inherit; font-size: .74rem; font-weight: 700; transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .btn:active { transform: scale(.98); }
  .btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .btn-primary { border-color: transparent; color: #050708; background: var(--color-primary); box-shadow: 0 4px 18px rgba(0, 255, 156, .22), var(--glow-primary); }
  .btn-primary:hover { filter: brightness(1.06); }
  .btn-secondary:hover { border-color: var(--color-primary-border); background: var(--color-primary-soft); box-shadow: var(--glow-primary); }
  .btn-danger { color: var(--color-danger); }
  .btn-danger:hover { border-color: rgba(255, 77, 109, .45); background: rgba(255, 77, 109, .08); }
  .inline-form { display: inline-flex; padding: 0; }

  .registry-list { display: grid; gap: 12px; margin-top: 16px; }
  .record { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); overflow: hidden; transition: border-color var(--motion-fast) var(--ease-out); }
  .record[open] { border-color: var(--color-primary-border); box-shadow: var(--glow-primary); }
  .record summary { padding: 14px 16px; }
  .provider-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; color: var(--color-primary); background: var(--color-primary-soft); border: 1px solid var(--color-primary-border); font-size: .58rem; font-weight: 800; flex: 0 0 auto; }
  .record-main { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1; }
  .record-copy { min-width: 0; }
  .record-copy strong { display: inline-flex; align-items: center; gap: 8px; color: var(--color-text); font-size: .82rem; font-weight: 700; }
  .default-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 999px; color: #050708; background: var(--color-primary); border: 1px solid var(--color-primary-border); font-size: .5rem; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; box-shadow: var(--glow-primary); }
  .record-sub { display: block; margin-top: 3px; color: var(--color-text-deep); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .56rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .record-meta { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }

  @media (max-width: 700px) {
    .form-grid.two, .form-grid.three { grid-template-columns: 1fr; }
    .record-meta { gap: 4px; }
  }
</style>
