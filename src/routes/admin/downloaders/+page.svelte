<script lang="ts">
  import { Check, ChevronDown, Download, Plus, Star, Trash2, X } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import type { ActionData, PageData } from './$types';
  import { slugifyTitle } from '$lib/shared/downloader';

  export let data: PageData;
  export let form: ActionData;

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
  <div class="eyebrow">MAVERO / Downloader registry</div>
  <div class="heading-row">
    <div>
      <h1>Downloaders <em>registry.</em></h1>
      <p class="intro">A separate registry of download providers — independent from streaming providers/sources. HTTPS-only URL templates with known placeholders. Exactly one default at a time.</p>
    </div>
    <span class="count">{data.providers.length} records · {data.overview.enabledCount} enabled</span>
  </div>

  {#if data.notice}<div class="notice" role="status"><Check size={15} /> {data.notice}</div>{/if}
  {#if form?.message}<div class="error" role="alert">{form.message}</div>{/if}

  <details class="form-panel" open={data.providers.length === 0}>
    <summary><span><Plus size={15} /> Add downloader</span><ChevronDown size={16} /></summary>
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
      <div class="form-actions"><button class="btn btn-primary" type="submit"><Plus size={14} /> Create downloader</button><span class="hint">No third-party calls are made from this admin.</span></div>
    </form>
  </details>

  {#if data.providers.length === 0}
    <div class="empty"><Download size={22} /><h2>No downloaders yet</h2><p>Create the first downloader above. It will remain disabled until explicitly enabled.</p></div>
  {:else}
    <div class="registry-list">
      {#each data.providers as provider}
        <details class="record">
          <summary>
            <div class="record-main">
              <span class="provider-icon">{provider.icon || 'DL'}</span>
              <div>
                <strong>{provider.name}{#if provider.is_default}<span class="default-badge"><Star size={11} fill="currentColor" strokeWidth={0} /> Default</span>{/if}</strong>
                <span>{provider.slug} · {supportsMovieLabel(provider)} · order {provider.ordering}</span>
              </div>
            </div>
            <div class="record-meta">
              <span class:good={provider.enabled} class:warning={!provider.enabled}>{provider.enabled ? 'Enabled' : 'Disabled'}</span>
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
  em { color: var(--accent); font-style: normal; }
  .heading-row { display: flex; align-items: end; justify-content: space-between; gap: 20px; }
  h1 { margin: 8px 0 9px; color: var(--ink); font-size: clamp(1.7rem, 3.2vw, 2.4rem); font-weight: 900; letter-spacing: -.02em; line-height: 1.1; }
  .intro { max-width: 640px; margin: 0; color: var(--muted); font-size: .78rem; line-height: 1.65; }
  .count, .hint { color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .58rem; }
  .hint { display: block; margin-top: 4px; line-height: 1.5; }
  .hint code { color: var(--ink); background: rgba(255,255,255,.04); padding: 1px 5px; border-radius: 4px; font-family: 'JetBrains Mono', monospace; font-size: .54rem; }
  .notice, .error { display: flex; align-items: center; gap: 8px; margin-top: 18px; padding: 11px 13px; border-radius: 9px; font-size: .72rem; }
  .notice { color: var(--success); border: 1px solid rgba(126,220,180,.2); background: rgba(126,220,180,.06); }
  .error { color: #ff8a8a; border: 1px solid rgba(228,133,105,.25); background: rgba(228,133,105,.07); }
  .form-panel, .record { margin-top: 19px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
  summary { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 17px 19px; cursor: pointer; list-style: none; color: var(--ink); font-size: .8rem; }
  summary::-webkit-details-marker { display: none; }
  summary > span, .record-main, .record-meta { display: flex; align-items: center; gap: 9px; }
  summary > span { color: var(--accent); }
  .registry-form { display: grid; gap: 13px; padding: 0 19px 19px; }
  .registry-form.compact { padding-top: 0; border-top: 1px solid var(--line); }
  .form-grid { display: grid; gap: 10px; }
  .form-grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .form-grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  label { display: grid; gap: 6px; color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .57rem; }
  input, textarea { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 10px 11px; color: var(--ink); background: rgba(255,255,255,.035); font: inherit; font-family: inherit; font-size: .68rem; outline: none; }
  input:focus, textarea:focus { border-color: rgba(155,135,245,.7); box-shadow: 0 0 0 3px rgba(155,135,245,.1); }
  textarea { resize: vertical; line-height: 1.5; }
  .check { display: flex; align-items: center; gap: 8px; min-height: 38px; padding: 8px; border: 1px solid var(--line); border-radius: 8px; }
  .check input { width: auto; accent-color: var(--accent); }
  .form-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .secondary-actions { padding: 0 19px 16px; }
  .btn { display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; cursor: pointer; color: var(--ink); background: transparent; font: inherit; font-size: .66rem; }
  .btn-primary { border-color: transparent; color: #12121a; background: var(--ink); }
  .btn-secondary:hover { border-color: rgba(155,135,245,.45); background: var(--accent-soft); }
  .btn-danger { color: #ff8a8a; }
  .btn-danger:hover { border-color: rgba(228,133,105,.35); background: rgba(228,133,105,.08); }
  .inline-form { display: inline-flex; padding: 0; }
  .registry-list { display: grid; gap: 10px; margin-top: 15px; }
  .record { margin-top: 0; }
  .record summary { padding: 14px 16px; }
  .provider-icon { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; color: var(--accent); background: var(--accent-soft); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .58rem; font-weight: 700; }
  .record-main strong { display: inline-flex; align-items: center; gap: 8px; color: var(--ink); font-size: .78rem; }
  .default-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 999px; color: #0d0d0d; background: #f5f5f5; font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .5rem; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; }
  .record-main span:not(.provider-icon):not(.default-badge) { display: block; margin-top: 3px; color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .54rem; }
  .record-meta { color: var(--muted-deep); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .55rem; }
  .record-meta .good { color: var(--success); }
  .record-meta .warning { color: #ffb020; }
  .empty { margin-top: 15px; padding: 45px 20px; text-align: center; border: 1px dashed var(--line); border-radius: 14px; }
  .empty h2 { margin: 10px 0 5px; font-size: 1rem; }
  .empty p { margin: 0; color: var(--muted); font-size: .72rem; }
  @media (max-width: 700px) {
    .heading-row { align-items: start; flex-direction: column; }
    .form-grid.two, .form-grid.three { grid-template-columns: 1fr; }
    .record-meta span:nth-child(1) { display: none; }
  }
</style>
