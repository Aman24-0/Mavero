<script lang="ts">
  /**
   * Admin 2.0 — Phase G — API & Sources workspace.
   *
   * Unified workspace with two contextual tabs:
   *   - Providers — provider registry (identity, adapter, capabilities, config state)
   *   - Sources — source registry (playback source entries with provider mappings)
   *
   * Plus a contextual Defaults sheet for per-content-type default source configuration.
   *
   * This is CONFIGURATION-oriented (distinct from Phase E Hosting Control which is
   * OPERATIONAL). Phase G manages what providers/sources exist and how they're
   * configured. Phase E monitors their health/assets/sync.
   *
   * The provider/source CRUD forms are complex (408 + 441 lines in the legacy
   * pages). Phase G wraps them in the new Admin 2.0 shell and provides the unified
   * entry point. The existing server actions are reused unchanged.
   */

  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminStatus from '$lib/components/admin2/AdminStatus.svelte';
  import { Settings, SlidersHorizontal, X, ExternalLink, Check, Server, HardDrive, AlertCircle, Cog } from 'lucide-svelte';
  import { CAPABILITY_FIELDS, CAPABILITY_LABELS, type ProviderPlaybackCapabilities } from '$lib/shared/player-capabilities';
  import { sandboxPolicyFromCapabilities } from '$lib/shared/sandbox-policy';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const VALID_TABS = new Set(['providers', 'sources']);
  let currentTab = $state<string>(VALID_TABS.has(data.initialTab) ? data.initialTab : 'providers');

  $effect(() => {
    const urlTab = page.url.searchParams.get('tab') ?? 'providers';
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

  // --- Defaults sheet state ---
  let defaultsOpen = $state(false);

  // --- Helpers ---
  function statusTone(status: string): 'green' | 'amber' | 'red' | 'neutral' {
    if (status === 'active' || status === 'experimental') return 'green';
    if (status === 'maintenance') return 'amber';
    if (status === 'unavailable' || status === 'disabled') return 'neutral';
    return 'neutral';
  }

  function providerForSource(source: any): any | null {
    return data.providers.find((p: any) => p.id === source.provider_id) ?? null;
  }

  function defaultForType(type: string): any | null {
    return data.defaults.find((d: any) => d.content_type === type) ?? null;
  }

  function sourceName(sourceId: string | null): string {
    if (!sourceId) return '—';
    const source = data.sources.find((s: any) => s.id === sourceId);
    return source?.name ?? '—';
  }

  function isSourceEligible(source: any): boolean {
    return source.enabled && source.visibility === 'public' && (source.status === 'active' || source.status === 'experimental');
  }

  const CONTENT_TYPES = [
    { type: 'movie', label: 'Movies' },
    { type: 'series', label: 'Series' },
    { type: 'anime', label: 'Anime' },
    { type: 'adult', label: 'Adult' },
  ];

  function capabilityState(providerId: string, field: keyof ProviderPlaybackCapabilities): 'supported' | 'unsupported' | 'unknown' {
    const entry = data.capabilityMap?.[providerId] ?? null;
    if (!entry) return 'unknown';
    if (entry.supported.includes(field)) return 'supported';
    return 'unsupported';
  }

  function sandboxOn(provider: any): boolean {
    return sandboxPolicyFromCapabilities(provider.capabilities) === 'required';
  }

  const tabs = [
    { id: 'providers', label: 'Providers' },
    { id: 'sources', label: 'Sources' },
  ];
</script>

<svelte:head>
  <title>API & Sources — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell active="api-sources">
  <AdminPage
    eyebrow="System"
    title="API & Sources"
    accent="cyan"
    tabs={tabs.map((t) => ({ id: t.id, label: t.label, active: t.id === currentTab, onclick: () => switchTab(t.id) }))}
  >
    {#snippet actions()}
      <button type="button" class="a2-defaults-btn" onclick={() => { defaultsOpen = true; }}>
        <SlidersHorizontal size={13} /> Defaults
      </button>
    {/snippet}

    {#snippet description()}
      <p>Provider registry and playback source configuration. Manage which providers exist, their capabilities, and how sources are exposed to the application.</p>
    {/snippet}

    {#if data.notice}
      <div class="a2-notice" role="status"><Check size={14} /> {data.notice}</div>
    {/if}

    {#if currentTab === 'providers'}
      <!-- Providers tab -->
      {#if data.providers.length === 0}
        <div class="a2-empty">
          <Server size={32} />
          <h3>No providers configured</h3>
          <p>Create the first provider to begin configuring playback sources.</p>
        </div>
      {:else}
        <div class="a2-provider-grid">
          {#each data.providers as provider (provider.id)}
            <article class="a2-provider-card" data-enabled={provider.enabled}>
              <header class="a2-provider-card-head">
                <div class="a2-provider-card-id">
                  <span class="a2-provider-card-icon">{provider.icon ?? '🔧'}</span>
                  <div>
                    <h3 class="a2-provider-card-name">{provider.name}</h3>
                    <span class="a2-provider-card-adapter mono">{provider.adapter_id}</span>
                  </div>
                </div>
                <AdminStatus label={provider.status} tone={statusTone(provider.status)} />
              </header>

              <dl class="a2-provider-card-meta">
                <div><dt>Slug</dt><dd class="mono">{provider.slug}</dd></div>
                <div><dt>Integration</dt><dd>{provider.integration_type}</dd></div>
                <div><dt>Enabled</dt><dd>{provider.enabled ? 'Yes' : 'No'}</dd></div>
                <div><dt>Sandbox</dt><dd>{sandboxOn(provider) ? 'Required' : 'Unrestricted'}</dd></div>
              </dl>

              <div class="a2-provider-card-caps">
                {#each CAPABILITY_FIELDS.slice(0, 7) as field}
                  {@const state = capabilityState(provider.id, field)}
                  <span class="a2-cap-dot" class:is-on={state === 'supported'} class:is-off={state === 'unsupported'} class:is-unknown={state === 'unknown'} title={CAPABILITY_LABELS[field]}>
                    {CAPABILITY_LABELS[field].slice(0, 3)}
                  </span>
                {/each}
              </div>

              <div class="a2-provider-card-source-count">
                {data.sources.filter((s: any) => s.provider_id === provider.id).length} source(s)
              </div>
            </article>
          {/each}
        </div>

        <div class="a2-legacy-link">
          <a href="/admin/providers" class="a2-legacy-link-btn">
            <ExternalLink size={12} /> Open provider registry (full CRUD)
          </a>
        </div>
      {/if}
    {:else if currentTab === 'sources'}
      <!-- Sources tab -->
      {#if data.sources.length === 0}
        <div class="a2-empty">
          <HardDrive size={32} />
          <h3>No sources configured</h3>
          <p>Create the first playback source to expose content to the application.</p>
        </div>
      {:else}
        <div class="a2-source-table-wrap">
          <table class="a2-source-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Provider</th>
                <th>Integration</th>
                <th>Status</th>
                <th>Enabled</th>
                <th>Visibility</th>
                <th>Order</th>
              </tr>
            </thead>
            <tbody>
              {#each data.sources as source (source.id)}
                {@const provider = providerForSource(source)}
                <tr>
                  <td>
                    <div class="a2-source-cell">
                      <span class="a2-source-icon">{source.icon ?? '📦'}</span>
                      <div>
                        <div class="a2-source-name">{source.name}</div>
                        <div class="a2-source-slug mono">{source.slug}</div>
                      </div>
                    </div>
                  </td>
                  <td>{provider?.name ?? '—'}</td>
                  <td><span class="a2-source-badge">{source.integration_type}</span></td>
                  <td><AdminStatus label={source.status} tone={statusTone(source.status)} /></td>
                  <td>{source.enabled ? '✓' : '—'}</td>
                  <td>{source.visibility}</td>
                  <td class="mono">{source.ordering}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        <div class="a2-legacy-link">
          <a href="/admin/sources" class="a2-legacy-link-btn">
            <ExternalLink size={12} /> Open source registry (full CRUD)
          </a>
        </div>
      {/if}
    {/if}
  </AdminPage>
</AdminAppShell>

<!-- Defaults sheet -->
{#if defaultsOpen}
  <div class="a2-defaults-overlay" onclick={() => { defaultsOpen = false; }} role="presentation">
    <aside class="a2-defaults-sheet" role="dialog" aria-modal="true" aria-labelledby="a2-defaults-title" onclick={(e) => e.stopPropagation()}>
      <header class="a2-defaults-head">
        <h2 id="a2-defaults-title" class="a2-defaults-title"><SlidersHorizontal size={16} /> Default Sources</h2>
        <button type="button" class="a2-defaults-close" onclick={() => { defaultsOpen = false; }} aria-label="Close">
          <X size={16} />
        </button>
      </header>
      <div class="a2-defaults-body">
        <p class="a2-defaults-desc">
          Configure which source is preferred for each content type. The resolver uses these defaults
          when no category-specific ordering applies.
        </p>
        {#each CONTENT_TYPES as ct}
          {@const def = defaultForType(ct.type)}
          <form class="a2-default-row" method="POST" action="?/saveDefault">
            <div class="a2-default-row-label">
              <span class="a2-default-row-type">{ct.label}</span>
              <span class="a2-default-row-current">
                {#if def?.source_id}
                  Current: <strong>{sourceName(def.source_id)}</strong>
                {:else}
                  <span class="a2-default-row-none">No default set</span>
                {/if}
              </span>
            </div>
            <div class="a2-default-row-control">
              <input type="hidden" name="content_type" value={ct.type} />
              <select name="source_id" class="a2-default-select">
                <option value="">— Select source —</option>
                {#each data.sources as source (source.id)}
                  {@const eligible = isSourceEligible(source)}
                  <option value={source.id} selected={def?.source_id === source.id} disabled={!eligible}>
                    {source.name}{#if !eligible} (ineligible){/if}
                  </option>
                {/each}
              </select>
              <button type="submit" class="a2-default-save">Save</button>
              {#if def?.source_id}
                <form method="POST" action="?/clearDefault" class="a2-default-clear-form">
                  <input type="hidden" name="content_type" value={ct.type} />
                  <button type="submit" class="a2-default-clear">Clear</button>
                </form>
              {/if}
            </div>
          </form>
        {/each}
      </div>
    </aside>
  </div>
{/if}

<style>
  .a2-notice {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-green-soft); border: 1px solid var(--a2-green-border);
    border-radius: var(--a2-radius-sm); color: var(--a2-green);
    font-size: var(--a2-text-sm);
  }

  .a2-defaults-btn {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-4);
    background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-sm); color: var(--a2-text);
    font-size: var(--a2-text-sm); font-weight: 600; cursor: pointer;
    transition: all var(--a2-motion-micro, 140ms) var(--a2-ease-out);
  }
  .a2-defaults-btn:hover { background: var(--a2-cyan-soft); border-color: var(--a2-cyan); color: var(--a2-cyan); }

  .a2-empty {
    display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-3);
    padding: var(--a2-space-8); text-align: center; color: var(--a2-text-muted);
  }
  .a2-empty h3 { margin: 0; font-size: var(--a2-text-base); color: var(--a2-text); }
  .a2-empty p { margin: 0; font-size: var(--a2-text-sm); max-width: 420px; }

  /* ---- Providers ---- */
  .a2-provider-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: var(--a2-space-3);
  }
  @media (max-width: 768px) { .a2-provider-grid { grid-template-columns: 1fr; } }

  .a2-provider-card {
    display: flex; flex-direction: column; gap: var(--a2-space-3);
    padding: var(--a2-space-4);
    background: var(--a2-surface-2); border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
    transition: border-color var(--a2-motion-micro, 140ms) var(--a2-ease-out);
  }
  .a2-provider-card:hover { border-color: var(--a2-cyan-border); }
  .a2-provider-card[data-enabled="false"] { opacity: 0.7; }

  .a2-provider-card-head {
    display: flex; justify-content: space-between; align-items: flex-start; gap: var(--a2-space-2);
  }
  .a2-provider-card-id { display: inline-flex; align-items: center; gap: var(--a2-space-3); }
  .a2-provider-card-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; border-radius: var(--a2-radius-sm);
    background: var(--a2-surface-4); font-size: 16px;
  }
  .a2-provider-card-name { margin: 0; font-size: var(--a2-text-sm); font-weight: 700; color: var(--a2-text-bright); }
  .a2-provider-card-adapter { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; }

  .a2-provider-card-meta {
    display: grid; grid-template-columns: 1fr 1fr; gap: var(--a2-space-2) var(--a2-space-4); margin: 0;
  }
  .a2-provider-card-meta > div { display: flex; flex-direction: column; gap: 1px; }
  .a2-provider-card-meta dt { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .a2-provider-card-meta dd { margin: 0; font-size: var(--a2-text-xs); color: var(--a2-text); }

  .a2-provider-card-caps { display: flex; flex-wrap: wrap; gap: 2px; }
  .a2-cap-dot {
    display: inline-flex; align-items: center; justify-content: center;
    padding: 1px 4px; border-radius: var(--a2-radius-xs);
    font-size: 9px; font-weight: 700; text-transform: uppercase;
  }
  .a2-cap-dot.is-on { background: var(--a2-green-soft); color: var(--a2-green); }
  .a2-cap-dot.is-off { background: var(--a2-surface-4); color: var(--a2-text-dim); }
  .a2-cap-dot.is-unknown { background: var(--a2-surface-4); color: var(--a2-text-dim); opacity: 0.5; }

  .a2-provider-card-source-count {
    font-size: var(--a2-text-2xs); color: var(--a2-text-muted); padding-top: var(--a2-space-1);
    border-top: 1px solid var(--a2-border);
  }

  /* ---- Sources table ---- */
  .a2-source-table-wrap {
    overflow-x: auto; background: var(--a2-surface-2);
    border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md);
  }
  .a2-source-table { width: 100%; border-collapse: collapse; font-size: var(--a2-text-xs); }
  .a2-source-table thead th {
    padding: var(--a2-space-2) var(--a2-space-3); text-align: left;
    font-size: var(--a2-text-2xs); font-weight: 700; color: var(--a2-text-dim);
    text-transform: uppercase; letter-spacing: 0.06em;
    border-bottom: 1px solid var(--a2-border-strong); white-space: nowrap;
    background: var(--a2-surface-3);
  }
  .a2-source-table tbody tr { border-bottom: 1px solid var(--a2-border); }
  .a2-source-table tbody tr:hover { background: var(--a2-surface-3); }
  .a2-source-table tbody td { padding: var(--a2-space-2) var(--a2-space-3); color: var(--a2-text); }

  .a2-source-cell { display: inline-flex; align-items: center; gap: var(--a2-space-2); }
  .a2-source-icon { font-size: 16px; }
  .a2-source-name { font-weight: 600; color: var(--a2-text-bright); }
  .a2-source-slug { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); }
  .a2-source-badge {
    display: inline-block; padding: 1px 6px; background: var(--a2-surface-4);
    border-radius: var(--a2-radius-xs); font-size: var(--a2-text-2xs);
    text-transform: uppercase; color: var(--a2-text-muted);
  }

  /* ---- Legacy link ---- */
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

  /* ---- Defaults sheet ---- */
  .a2-defaults-overlay {
    position: fixed; inset: 0; z-index: 80;
    background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(2px);
    display: flex; justify-content: flex-end;
    animation: a2-fade-in var(--a2-motion-normal, 240ms) var(--a2-ease-out);
  }
  @keyframes a2-fade-in { from { opacity: 0; } to { opacity: 1; } }
  .a2-defaults-sheet {
    width: 100%; max-width: 480px; background: var(--a2-surface-1);
    border-left: 1px solid var(--a2-border-strong);
    display: flex; flex-direction: column; overflow-y: auto;
    animation: a2-slide-in var(--a2-motion-normal, 240ms) var(--a2-ease-out);
  }
  @keyframes a2-slide-in { from { transform: translateX(100%); } to { transform: translateX(0); } }

  .a2-defaults-head {
    padding-top: env(safe-area-inset-top, 0px);
    display: flex; justify-content: space-between; align-items: center;
    gap: var(--a2-space-3); padding: var(--a2-space-4);
    border-bottom: 1px solid var(--a2-border);
    position: sticky; top: 0; background: var(--a2-surface-1); z-index: 1;
  }
  .a2-defaults-title {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    margin: 0; font-size: var(--a2-text-base); font-weight: 700; color: var(--a2-text-bright);
  }
  .a2-defaults-close {
    min-width: 44px;
    min-height: 44px;
    background: transparent; border: none; cursor: pointer;
    color: var(--a2-text-muted); padding: 4px; border-radius: var(--a2-radius-xs);
  }
  .a2-defaults-close:hover { background: var(--a2-surface-3); color: var(--a2-text); }

  .a2-defaults-body {
    padding-bottom: env(safe-area-inset-bottom, 0px); padding: var(--a2-space-4); display: flex; flex-direction: column; gap: var(--a2-space-4); }
  .a2-defaults-desc { margin: 0 0 var(--a2-space-2); font-size: var(--a2-text-sm); color: var(--a2-text-muted); line-height: 1.5; }

  .a2-default-row {
    display: flex; flex-direction: column; gap: var(--a2-space-2);
    padding: var(--a2-space-3); background: var(--a2-surface-2);
    border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm);
  }
  .a2-default-row-label { display: flex; justify-content: space-between; align-items: center; }
  .a2-default-row-type { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); }
  .a2-default-row-current { font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }
  .a2-default-row-none { color: var(--a2-text-dim); font-style: italic; }
  .a2-default-row-control { display: flex; gap: var(--a2-space-1); align-items: center; }
  .a2-default-select {
    flex: 1; background: var(--a2-surface-3); border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-xs);
    padding: 4px 8px; cursor: pointer;
  }
  .a2-default-save {
    padding: 4px 10px; background: var(--a2-cyan); color: var(--a2-surface-1);
    border: none; border-radius: var(--a2-radius-sm);
    font-size: var(--a2-text-2xs); font-weight: 600; cursor: pointer;
  }
  .a2-default-clear-form { display: inline; }
  .a2-default-clear {
    padding: 4px 10px; background: var(--a2-surface-4); color: var(--a2-text-muted);
    border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm);
    font-size: var(--a2-text-2xs); font-weight: 600; cursor: pointer;
  }

  .mono { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); }

  @media (max-width: 768px) {
    .a2-defaults-sheet { max-width: 100%; }
    .a2-default-row-control { flex-wrap: wrap; }
  }

  @media (prefers-reduced-motion: reduce) {
    .a2-defaults-sheet, .a2-defaults-overlay, .a2-defaults-btn, .a2-provider-card, .a2-legacy-link-btn { animation: none; transition: none; }
  }
</style>
