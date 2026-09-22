<script lang="ts">
  import { Check, AlertTriangle, Star } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const contentTypes = [
    { key: 'movie', label: 'Movie', description: 'Default source for movies (single video, no season/episode).' },
    { key: 'series', label: 'Series', description: 'Default source for TV series (season + episode required).' },
    { key: 'anime', label: 'Anime', description: 'Default source for anime (season + episode required).' },
    { key: 'adult', label: 'Adult', description: 'Default playback source for authorized Adult content.' },
  ] as const;

  // Helper: find the current default source for a content type.
  const defaultFor = (contentType: string) => data.defaults.find((d) => d.content_type === contentType);

  // Helper: find the source row for a source id.
  const sourceById = (sourceId: string | undefined) => (sourceId ? data.sources.find((s) => s.id === sourceId) : undefined);

  // Helper: find the provider name for a source.
  const providerName = (providerId: string) => data.providers.find((p) => p.id === providerId)?.name ?? 'Unknown provider';

  // Helper: check if a source is eligible for public config (enabled + public + active/experimental).
  const isEligible = (source: { enabled: boolean; visibility: string; status: string }) =>
    source.enabled && source.visibility === 'public' && (source.status === 'active' || source.status === 'experimental');

  // Helper: label for a source's eligibility status.
  const eligibilityLabel = (source: { enabled: boolean; visibility: string; status: string }) => {
    if (!source.enabled) return 'Disabled';
    if (source.visibility !== 'public') return source.visibility;
    if (source.status !== 'active' && source.status !== 'experimental') return source.status;
    return 'Eligible';
  };
</script>

<svelte:head><title>Default Sources — Mavero</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<AdminShell active="defaults">
  <AdminPageHeader
    eyebrow="MAVERO / Default sources"
    title="Playback"
    accent="defaults."
  />

  {#if data.notice}<div class="notice" role="status"><Check size={15} /> {data.notice}</div>{/if}
  {#if form?.message}<div class="error" role="alert">{form.message}</div>{/if}

  <div class="defaults-grid">
    {#each contentTypes as ct}
      {@const current = defaultFor(ct.key)}
      {@const currentSource = sourceById(current?.source_id)}
      {@const ineligible = currentSource ? !isEligible(currentSource) : false}
      <div class="default-card" class:ineligible>
        <div class="card-header">
          <div class="card-title"><Star size={16} /> <strong>{ct.label}</strong></div>
          {#if current}
            <AdminStatusBadge label="Default set" tone="good" />
          {:else}
            <AdminStatusBadge label="No default" tone="neutral" />
          {/if}
        </div>
        <p class="card-desc">{ct.description}</p>

        {#if currentSource}
          <div class="current-default" class:ineligible>
            <div class="current-label">Current default</div>
            <div class="current-name">{currentSource.name}</div>
            <div class="current-meta">{providerName(currentSource.provider_id)} · {eligibilityLabel(currentSource)}</div>
          </div>
          {#if ineligible}
            <div class="warning" role="alert"><AlertTriangle size={14} /> <span>Source is currently <strong>{eligibilityLabel(currentSource)}</strong>. Public configuration will omit it until the source becomes eligible again. The default is preserved so it auto-activates when re-enabled.</span></div>
          {/if}
        {:else}
          <div class="current-default none">
            <div class="current-label">No default configured</div>
            <div class="current-meta">Resolver uses health-ranked fallback.</div>
          </div>
        {/if}

        <form method="POST" action="?/saveDefault" class="default-form">
          <input type="hidden" name="content_type" value={ct.key} />
          <label>
            <span>Select source</span>
            <select name="source_id" required>
              <option value="" disabled selected>Choose a source…</option>
              {#each data.sources as source}
                {@const provider = providerName(source.provider_id)}
                {@const selected = current?.source_id === source.id}
                {@const eligible = isEligible(source)}
                <option value={source.id} {selected}>{source.name} · {provider}{!eligible ? ` (${eligibilityLabel(source)})` : ''}</option>
              {/each}
            </select>
          </label>
          <div class="form-actions">
            <button class="btn btn-primary" type="submit">Save {ct.label.toLowerCase()} default</button>
            {#if current}
              <button class="btn btn-danger" type="submit" formaction="?/clearDefault" onsubmit={() => confirm(`Clear the ${ct.label.toLowerCase()} default?`)}>Clear</button>
            {/if}
          </div>
        </form>
      </div>
    {/each}
  </div>
</AdminShell>

<style>
  .notice, .error { display: flex; align-items: center; gap: 8px; margin-top: 18px; padding: 11px 13px; border-radius: var(--radius-sm); font-size: .72rem; }
  .notice { color: var(--color-primary); border: 1px solid var(--color-primary-border); background: rgba(0, 255, 156, .06); }
  .error { color: var(--color-danger); border: 1px solid rgba(255, 77, 109, .25); background: rgba(255, 77, 109, .07); }

  .defaults-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px; margin-top: 12px; }
  .default-card { display: grid; gap: 13px; padding: 18px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); }
  .default-card.ineligible { border-color: rgba(255, 194, 71, .35); }
  .card-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .card-title { display: flex; align-items: center; gap: 8px; color: var(--color-text); font-size: .85rem; font-weight: 700; }
  .card-title :global(svg) { color: var(--color-primary); }
  .card-desc { margin: 0; color: var(--color-text-muted); font-size: .68rem; line-height: 1.55; }

  .current-default { padding: 12px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface-elevated); }
  .current-default.ineligible { border-color: rgba(255, 194, 71, .35); background: rgba(255, 194, 71, .04); }
  .current-default.none { border-style: dashed; }
  .current-label { color: var(--color-text-deep); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .52rem; text-transform: uppercase; letter-spacing: .08em; }
  .current-name { margin-top: 4px; color: var(--color-text); font-size: .82rem; font-weight: 700; }
  .current-meta { margin-top: 2px; color: var(--color-text-muted); font-size: .58rem; }

  .warning { display: flex; align-items: start; gap: 8px; padding: 10px 12px; border: 1px solid rgba(255, 194, 71, .3); border-radius: var(--radius-sm); color: var(--color-warning); background: rgba(255, 194, 71, .05); font-size: .64rem; line-height: 1.5; }

  .default-form { display: grid; gap: 10px; }
  label { display: grid; gap: 5px; color: var(--color-text-muted); font-size: .58rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  select {
    width: 100%; box-sizing: border-box;
    min-height: 44px;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    color: var(--color-text);
    background: var(--color-surface-elevated);
    font: inherit;
    font-size: .78rem;
    outline: none;
    transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out);
  }
  select:focus { border-color: var(--color-primary); background: var(--color-surface-raised); box-shadow: var(--glow-primary); }

  .form-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .btn { display: inline-flex; align-items: center; gap: 7px; min-height: 40px; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); padding: 0 14px; cursor: pointer; color: var(--color-text); background: var(--color-primary-soft); font: inherit; font-size: .74rem; font-weight: 700; transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out); }
  .btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .btn-primary { border-color: transparent; color: #050708; background: var(--color-primary); box-shadow: 0 4px 18px rgba(0, 255, 156, .22), var(--glow-primary); }
  .btn-danger { color: var(--color-danger); }
  .btn-danger:hover { border-color: rgba(255, 77, 109, .45); background: rgba(255, 77, 109, .08); }

  @media (max-width: 700px) {
    .defaults-grid { grid-template-columns: 1fr; }
  }
</style>
