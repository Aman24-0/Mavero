<script lang="ts">
  /**
   * Admin 2.0 — Phase 1 — API & Sources workspace.
   *
   * Canonical workspace with full CRUD for providers, sources, and defaults.
   * No redirects to legacy UI — all management happens here.
   *
   * The provider/source forms use the same server actions as the legacy
   * /admin/providers and /admin/sources pages (now moved to this route's
   * +page.server.ts). The forms are rendered inside AdminAppShell + AdminPage.
   */

  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminStatus from '$lib/components/admin2/AdminStatus.svelte';
  import AdminSheet from '$lib/components/admin/AdminSheet.svelte';
  import AdminFormSection from '$lib/components/admin/AdminFormSection.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import AdminAddButton from '$lib/components/admin/AdminAddButton.svelte';
  import { SlidersHorizontal, X, Check, Server, HardDrive, Edit3, Trash2, Power } from 'lucide-svelte';
  import { CAPABILITY_FIELDS, CAPABILITY_LABELS } from '$lib/shared/player-capabilities';
  import { sandboxPolicyFromCapabilities, sandboxPolicies } from '$lib/shared/sandbox-policy';
  import { integrationTypes, providerStatuses } from '$lib/shared/streaming';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const VALID_TABS = new Set(['providers', 'sources']);
  // svelte-ignore state_referenced_locally
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

  // --- Defaults sheet ---
  let defaultsOpen = $state(false);

  // --- Provider edit/create sheet ---
  let providerSheetOpen = $state(false);
  let editingProvider: any = $state(null);
  let providerSheetTrigger: HTMLElement | null = null;

  function openCreateProvider(event?: Event) {
    if (event) providerSheetTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    editingProvider = null;
    providerSheetOpen = true;
  }
  function openEditProvider(provider: any, event?: Event) {
    if (event) providerSheetTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    editingProvider = provider;
    providerSheetOpen = true;
  }
  function closeProviderSheet() {
    providerSheetOpen = false;
    editingProvider = null;
  }

  // --- Source edit/create sheet ---
  let sourceSheetOpen = $state(false);
  let editingSource: any = $state(null);
  let sourceSheetTrigger: HTMLElement | null = null;

  // --- Player Controls Position (per-source landscape control placement) ---
  // Bound to the form fields; also drives the live preview box. Loaded from
  // editingSource.capabilities.player_controls_position when the sheet opens.
  let controlsPositionMode = $state('default');
  let controlsHAnchor = $state('right');
  let controlsHOffset = $state(16);
  let controlsVAnchor = $state('bottom');
  let controlsVOffset = $state(16);
  let controlsPHAnchor = $state('');
  let controlsPHOffset = $state(0);
  let controlsPVAnchor = $state('');
  let controlsPVOffset = $state(0);
  let controlsLHAnchor = $state('');
  let controlsLHOffset = $state(0);
  let controlsLVAnchor = $state('');
  let controlsLVOffset = $state(0);

  function loadControlsPositionState(source: any) {
    const raw = source?.capabilities?.player_controls_position;
    const custom = raw && typeof raw === 'object' && raw.mode === 'custom' ? raw : null;
    controlsPositionMode = custom ? 'custom' : 'default';
    controlsHAnchor = custom?.horizontal?.anchor ?? 'right';
    controlsHOffset = typeof custom?.horizontal?.offsetPercent === 'number' ? custom.horizontal.offsetPercent : 16;
    controlsVAnchor = custom?.vertical?.anchor ?? 'bottom';
    controlsVOffset = typeof custom?.vertical?.offsetPercent === 'number' ? custom.vertical.offsetPercent : 16;
    controlsPHAnchor = custom?.portrait?.horizontal?.anchor ?? '';
    controlsPHOffset = typeof custom?.portrait?.horizontal?.offsetPercent === 'number' ? custom.portrait.horizontal.offsetPercent : 0;
    controlsPVAnchor = custom?.portrait?.vertical?.anchor ?? '';
    controlsPVOffset = typeof custom?.portrait?.vertical?.offsetPercent === 'number' ? custom.portrait.vertical.offsetPercent : 0;
    controlsLHAnchor = custom?.landscape?.horizontal?.anchor ?? '';
    controlsLHOffset = typeof custom?.landscape?.horizontal?.offsetPercent === 'number' ? custom.landscape.horizontal.offsetPercent : 0;
    controlsLVAnchor = custom?.landscape?.vertical?.anchor ?? '';
    controlsLVOffset = typeof custom?.landscape?.vertical?.offsetPercent === 'number' ? custom.landscape.vertical.offsetPercent : 0;
  }

  function resetControlsPosition() {
    controlsPositionMode = 'default';
    controlsHAnchor = 'right';
    controlsHOffset = 16;
    controlsVAnchor = 'bottom';
    controlsVOffset = 16;
    controlsPHAnchor = '';
    controlsPHOffset = 0;
    controlsPVAnchor = '';
    controlsPVOffset = 0;
    controlsLHAnchor = '';
    controlsLHOffset = 0;
    controlsLVAnchor = '';
    controlsLVOffset = 0;
  }

  // Preview placement — mirrors the runtime math in
  // $lib/shared/player-controls-position.ts (bounded, viewport-relative %).
  const controlsPreviewHStyle = $derived(
    controlsPositionMode !== 'custom'
      ? 'right:16px'
      : controlsHAnchor === 'center'
        ? 'left:50%;transform:translateX(-50%)'
        : `${controlsHAnchor}:${controlsHOffset}%`
  );
  const controlsPreviewVStyle = $derived(
    controlsPositionMode !== 'custom'
      ? 'bottom:16px'
      : controlsVAnchor === 'center'
        ? 'top:50%;transform:translateY(-50%)'
        : `${controlsVAnchor}:${controlsVOffset}%`
  );

  function openCreateSource(event?: Event) {
    if (event) sourceSheetTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    editingSource = null;
    loadControlsPositionState(null);
    sourceSheetOpen = true;
  }
  function openEditSource(source: any, event?: Event) {
    if (event) sourceSheetTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    editingSource = source;
    loadControlsPositionState(source);
    sourceSheetOpen = true;
  }
  function closeSourceSheet() {
    sourceSheetOpen = false;
    editingSource = null;
  }

  // --- Helpers ---
  function statusTone(status: string): 'good' | 'warn' | 'bad' | 'neutral' {
    if (status === 'active' || status === 'experimental') return 'good';
    if (status === 'maintenance') return 'warn';
    return 'neutral';
  }
  function sandboxOn(provider: any): boolean {
    return sandboxPolicyFromCapabilities(provider.capabilities) === 'required';
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

  const providerStatusLabels: Record<string, string> = { active: 'Active', disabled: 'Disabled', maintenance: 'Maintenance', experimental: 'Experimental', unavailable: 'Unavailable' };
  const integrationLabels: Record<string, string> = { template: 'Template', api: 'API', direct: 'Direct', embed: 'Embed', custom: 'Custom' };
  const sandboxPolicyLabels: Record<string, string> = { required: 'Required — secure sandbox', unrestricted: 'Unrestricted — warning' };

  function capabilityState(providerId: string, field: string): 'supported' | 'unsupported' | 'unknown' {
    const entry = data.capabilityMap?.[providerId] ?? null;
    if (!entry) return 'unknown';
    if (entry.supported.includes(field)) return 'supported';
    return 'unsupported';
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
      {#if currentTab === 'providers'}
        <AdminAddButton label="Add provider" onclick={openCreateProvider} />
      {:else}
        <AdminAddButton label="Add source" onclick={openCreateSource} />
      {/if}
    {/snippet}

    {#snippet description()}
      <p>Manage playback providers, sources, and default source configuration. All CRUD operations are available directly in this workspace.</p>
    {/snippet}

    {#if data.notice}
      <div class="a2-notice" role="status"><Check size={14} /> {data.notice}</div>
    {/if}
    {#if form?.message}
      <div class="a2-form-error" role="alert">{form.message}</div>
    {/if}

    {#if currentTab === 'providers'}
      <!-- Providers tab with full CRUD -->
      {#if data.providers.length === 0}
        <div class="a2-empty">
          <Server size={32} />
          <h3>No providers configured</h3>
          <p>Create the first provider to begin configuring playback sources.</p>
          <AdminAddButton label="Add provider" onclick={openCreateProvider} />
        </div>
      {:else}
        <div class="a2-provider-list">
          {#each data.providers as provider (provider.id)}
            <div class="a2-provider-row" data-enabled={provider.enabled}>
              <div class="a2-provider-row-main">
                <span class="a2-provider-row-icon">{provider.icon ?? '🔧'}</span>
                <div class="a2-provider-row-info">
                  <div class="a2-provider-row-name">{provider.name}</div>
                  <div class="a2-provider-row-meta">
                    <span class="mono">{provider.adapter_id}</span>
                    <span>·</span>
                    <span>{integrationLabels[provider.integration_type] ?? provider.integration_type}</span>
                    <span>·</span>
                    <span>{sandboxOn(provider) ? 'Sandboxed' : 'Unrestricted'}</span>
                  </div>
                </div>
              </div>
              <div class="a2-provider-row-actions">
                <AdminStatusBadge label={providerStatusLabels[provider.status] ?? provider.status} tone={statusTone(provider.status)} />
                <form method="POST" action="?/toggleProvider" style="display:inline">
                  <input type="hidden" name="id" value={provider.id} />
                  <input type="hidden" name="enabled" value={String(!provider.enabled)} />
                  <button type="submit" class="a2-icon-btn" title={provider.enabled ? 'Disable' : 'Enable'}>
                    <Power size={14} />
                  </button>
                </form>
                <button type="button" class="a2-icon-btn" onclick={(e) => openEditProvider(provider, e)} title="Edit">
                  <Edit3 size={14} />
                </button>
                <form method="POST" action="?/deleteProvider" style="display:inline" onsubmit={(e) => { if (!confirm('Delete this provider? This cannot be undone.')) e.preventDefault(); }}>
                  <input type="hidden" name="id" value={provider.id} />
                  <button type="submit" class="a2-icon-btn a2-icon-btn-danger" title="Delete">
                    <Trash2 size={14} />
                  </button>
                </form>
              </div>
            </div>
          {/each}
        </div>
      {/if}

    {:else if currentTab === 'sources'}
      <!-- Sources tab with full CRUD -->
      {#if data.sources.length === 0}
        <div class="a2-empty">
          <HardDrive size={32} />
          <h3>No sources configured</h3>
          <p>Create the first playback source to expose content to the application.</p>
          <AdminAddButton label="Add source" onclick={openCreateSource} />
        </div>
      {:else}
        <div class="a2-source-list">
          {#each data.sources as source (source.id)}
            {@const provider = providerForSource(source)}
            <div class="a2-source-row" data-enabled={source.enabled}>
              <div class="a2-source-row-main">
                <span class="a2-source-row-icon">{source.icon ?? '📦'}</span>
                <div class="a2-source-row-info">
                  <div class="a2-source-row-name">{source.name}</div>
                  <div class="a2-source-row-meta">
                    <span>{provider?.name ?? '—'}</span>
                    <span>·</span>
                    <span class="mono">{source.integration_type}</span>
                    <span>·</span>
                    <span>{source.visibility}</span>
                    <span>·</span>
                    <span>order: {source.ordering}</span>
                  </div>
                </div>
              </div>
              <div class="a2-source-row-actions">
                <AdminStatusBadge label={source.status} tone={statusTone(source.status)} />
                <form method="POST" action="?/toggleSource" style="display:inline">
                  <input type="hidden" name="id" value={source.id} />
                  <input type="hidden" name="enabled" value={String(!source.enabled)} />
                  <button type="submit" class="a2-icon-btn" title={source.enabled ? 'Disable' : 'Enable'}>
                    <Power size={14} />
                  </button>
                </form>
                <button type="button" class="a2-icon-btn" onclick={(e) => openEditSource(source, e)} title="Edit">
                  <Edit3 size={14} />
                </button>
                <form method="POST" action="?/deleteSource" style="display:inline" onsubmit={(e) => { if (!confirm('Delete this source? This cannot be undone.')) e.preventDefault(); }}>
                  <input type="hidden" name="id" value={source.id} />
                  <button type="submit" class="a2-icon-btn a2-icon-btn-danger" title="Delete">
                    <Trash2 size={14} />
                  </button>
                </form>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </AdminPage>
</AdminAppShell>

<!-- Defaults sheet -->
{#if defaultsOpen}
  <div class="a2-overlay" onclick={() => { defaultsOpen = false; }} onkeydown={(e) => { if (e.key === 'Escape') defaultsOpen = false; }} role="presentation">
    <div class="a2-sheet" role="dialog" aria-modal="true" aria-labelledby="a2-defaults-title" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
      <header class="a2-sheet-head">
        <h2 id="a2-defaults-title" class="a2-sheet-title"><SlidersHorizontal size={16} /> Default Sources</h2>
        <button type="button" class="a2-sheet-close" onclick={() => { defaultsOpen = false; }} aria-label="Close"><X size={16} /></button>
      </header>
      <div class="a2-sheet-body">
        <p class="a2-sheet-desc">Configure which source is preferred for each content type.</p>
        {#each CONTENT_TYPES as ct}
          {@const def = defaultForType(ct.type)}
          <div class="a2-default-row">
            <div class="a2-default-row-label">
              <span class="a2-default-row-type">{ct.label}</span>
              <span class="a2-default-row-current">
                {#if def?.source_id}Current: <strong>{sourceName(def.source_id)}</strong>{:else}<span class="a2-default-row-none">No default set</span>{/if}
              </span>
            </div>
            <div class="a2-default-row-control">
              <form method="POST" action="?/saveDefault" style="display:flex; gap:4px; flex:1;">
                <input type="hidden" name="content_type" value={ct.type} />
                <select name="source_id" class="a2-default-select">
                  <option value="">— Select —</option>
                  {#each data.sources as source (source.id)}
                    {@const eligible = isSourceEligible(source)}
                    <option value={source.id} selected={def?.source_id === source.id} disabled={!eligible}>
                      {source.name}{#if !eligible} (ineligible){/if}
                    </option>
                  {/each}
                </select>
                <button type="submit" class="a2-default-save">Save</button>
                {#if def?.source_id}
                  <button type="submit" formaction="?/clearDefault" name="content_type" value={ct.type} class="a2-default-clear">Clear</button>
                {/if}
              </form>
            </div>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<!-- Provider create/edit sheet -->
{#if providerSheetOpen}
  <AdminSheet open={providerSheetOpen} title={editingProvider ? `Edit ${editingProvider.name}` : 'Add Provider'} onClose={closeProviderSheet}>
    <form method="POST" action={editingProvider ? '?/updateProvider' : '?/createProvider'} class="a2-crud-form">
      {#if editingProvider}
        <input type="hidden" name="id" value={editingProvider.id} />
      {/if}
      <AdminFormSection heading="Identity">
        <label class="a2-field"><span>Name</span><input name="name" required value={editingProvider?.name ?? ''} /></label>
        <label class="a2-field"><span>Slug</span><input name="slug" required value={editingProvider?.slug ?? ''} /></label>
        <label class="a2-field"><span>Adapter ID</span><input name="adapter_id" required value={editingProvider?.adapter_id ?? ''} /></label>
        <label class="a2-field"><span>Integration Type</span>
          <select name="integration_type">
            {#each integrationTypes as t}<option value={t} selected={editingProvider?.integration_type === t}>{integrationLabels[t]}</option>{/each}
          </select>
        </label>
        <label class="a2-field"><span>Status</span>
          <select name="status">
            {#each providerStatuses as s}<option value={s} selected={editingProvider?.status === s}>{providerStatusLabels[s]}</option>{/each}
          </select>
        </label>
      </AdminFormSection>
      <AdminFormSection heading="Configuration">
        <label class="a2-field"><span>Icon URL</span><input name="icon" type="url" value={editingProvider?.icon ?? ''} placeholder="https://example.com/icon.svg" /></label>
        <label class="a2-field"><span>Description</span><input name="description" value={editingProvider?.description ?? ''} /></label>
        <label class="a2-field"><span>Notes</span><input name="notes" value={editingProvider?.notes ?? ''} /></label>
        <label class="a2-field">
          <span>Sandbox Policy</span>
          <select name="sandbox_policy">
            {#each sandboxPolicies as p}<option value={p} selected={editingProvider ? sandboxOn(editingProvider) === (p === 'required') : p === 'required'}>{sandboxPolicyLabels[p]}</option>{/each}
          </select>
        </label>
        <label class="a2-field"><span>Enabled</span><input type="checkbox" name="enabled" value="true" checked={editingProvider ? editingProvider.enabled : true} /></label>
      </AdminFormSection>
      {#if !editingProvider}
        <input type="hidden" name="capabilities" value={'{"movies":true}'} />
      {/if}
      <div class="a2-form-actions">
        <button type="submit" class="a2-btn-primary">{editingProvider ? 'Save' : 'Create'}</button>
        <button type="button" class="a2-btn-secondary" onclick={closeProviderSheet}>Cancel</button>
      </div>
    </form>
  </AdminSheet>
{/if}

<!-- Source create/edit sheet -->
{#if sourceSheetOpen}
  <AdminSheet open={sourceSheetOpen} title={editingSource ? `Edit ${editingSource.name}` : 'Add Source'} onClose={closeSourceSheet}>
    <form method="POST" action={editingSource ? '?/updateSource' : '?/createSource'} class="a2-crud-form">
      {#if editingSource}
        <input type="hidden" name="id" value={editingSource.id} />
      {/if}
      <AdminFormSection heading="Identity">
        <label class="a2-field"><span>Name</span><input name="name" required value={editingSource?.name ?? ''} /></label>
        <label class="a2-field"><span>Slug</span><input name="slug" required value={editingSource?.slug ?? ''} /></label>
        <label class="a2-field"><span>Provider</span>
          <select name="provider_id" required>
            <option value="">— Select provider —</option>
            {#each data.providers as p}<option value={p.id} selected={editingSource?.provider_id === p.id}>{p.name}</option>{/each}
          </select>
        </label>
        <label class="a2-field"><span>Integration Type</span>
          <select name="integration_type">
            {#each integrationTypes as t}<option value={t} selected={editingSource?.integration_type === t}>{integrationLabels[t]}</option>{/each}
          </select>
        </label>
        <label class="a2-field"><span>Status</span>
          <select name="status">
            {#each providerStatuses as s}<option value={s} selected={editingSource?.status === s}>{providerStatusLabels[s]}</option>{/each}
          </select>
        </label>
      </AdminFormSection>
      <AdminFormSection heading="Configuration">
        <label class="a2-field"><span>Icon</span><input name="icon" value={editingSource?.icon ?? ''} /></label>
        <label class="a2-field"><span>Visibility</span>
          <select name="visibility">
            <option value="public" selected={editingSource?.visibility === 'public'}>Public</option>
            <option value="internal" selected={editingSource?.visibility === 'internal'}>Internal</option>
            <option value="hidden" selected={editingSource?.visibility === 'hidden'}>Hidden</option>
          </select>
        </label>
        <label class="a2-field"><span>Ordering</span><input type="number" name="ordering" value={editingSource?.ordering ?? 0} /></label>
        <label class="a2-field"><span>Identifier Mode</span>
          <select name="identifier_mode">
            <option value="tmdb_id" selected={editingSource?.identifier_mode === 'tmdb_id'}>TMDB ID</option>
            <option value="imdb_id" selected={editingSource?.identifier_mode === 'imdb_id'}>IMDb ID</option>
            <option value="anilist_id" selected={editingSource?.identifier_mode === 'anilist_id'}>AniList ID</option>
            <option value="slug" selected={editingSource?.identifier_mode === 'slug'}>Slug</option>
            <option value="custom" selected={editingSource?.identifier_mode === 'custom'}>Custom</option>
          </select>
        </label>
        <label class="a2-field"><span>Language</span><input name="language" value={editingSource?.language ?? ''} /></label>
        <label class="a2-field"><span>Badge</span><input name="badge" value={editingSource?.badge ?? ''} /></label>
        <label class="a2-field"><span>Enabled</span><input type="checkbox" name="enabled" value="true" checked={editingSource ? editingSource.enabled : true} /></label>
      </AdminFormSection>
      <AdminFormSection heading="Templates">
        <label class="a2-field"><span>Movie Template</span><input name="movie_template" value={editingSource?.movie_template ?? ''} /></label>
        <label class="a2-field"><span>Series Template</span><input name="series_template" value={editingSource?.series_template ?? ''} /></label>
        <label class="a2-field"><span>Anime Template</span><input name="anime_template" value={editingSource?.anime_template ?? ''} /></label>
      </AdminFormSection>
      <AdminFormSection heading="Metadata">
        <label class="a2-field"><span>Description</span><input name="description" value={editingSource?.description ?? ''} /></label>
        <label class="a2-field"><span>Notes</span><input name="notes" value={editingSource?.notes ?? ''} /></label>
      </AdminFormSection>
      <!-- Player redesign: per-source Landscape-control placement. Persisted
           inside capabilities.player_controls_position; the player positions
           its bottom-right control group (Landscape/Fullscreen FAB + Episodes
           pill) from this config for THIS source only. -->
      <AdminFormSection heading="Player Controls Position">
        <p class="a2-field-hint">Place the MAVERO Landscape button relative to this provider's own fullscreen control. Percentages are viewport-relative (0–100). Sources without a custom placement use the default bottom-right corner.</p>
        <label class="a2-field"><span>Position Mode</span>
          <select name="controls_position_mode" bind:value={controlsPositionMode}>
            <option value="default">Default — bottom-right corner</option>
            <option value="custom">Custom — manual placement</option>
          </select>
        </label>
        {#if controlsPositionMode === 'custom'}
          <div class="a2-position-grid">
            <label class="a2-field"><span>Horizontal anchor</span>
              <select name="controls_position_h_anchor" bind:value={controlsHAnchor}>
                <option value="right">From right edge</option>
                <option value="left">From left edge</option>
                <option value="center">Centered</option>
              </select>
            </label>
            {#if controlsHAnchor !== 'center'}
              <label class="a2-field"><span>Horizontal offset %</span><input type="number" name="controls_position_h_offset" min="0" max="100" step="0.5" bind:value={controlsHOffset} /></label>
            {/if}
            <label class="a2-field"><span>Vertical anchor</span>
              <select name="controls_position_v_anchor" bind:value={controlsVAnchor}>
                <option value="bottom">From bottom edge</option>
                <option value="top">From top edge</option>
                <option value="center">Centered</option>
              </select>
            </label>
            {#if controlsVAnchor !== 'center'}
              <label class="a2-field"><span>Vertical offset %</span><input type="number" name="controls_position_v_offset" min="0" max="100" step="0.5" bind:value={controlsVOffset} /></label>
            {/if}
          </div>
          <details class="a2-position-overrides">
            <summary>Portrait / landscape overrides (optional)</summary>
            <div class="a2-position-grid">
              <span class="a2-position-axis-label">Portrait</span>
              <label class="a2-field"><span>H anchor</span>
                <select name="controls_position_p_h_anchor" bind:value={controlsPHAnchor}>
                  <option value="">Inherit</option>
                  <option value="right">From right</option>
                  <option value="left">From left</option>
                  <option value="center">Centered</option>
                </select>
              </label>
              <label class="a2-field"><span>H offset %</span><input type="number" name="controls_position_p_h_offset" min="0" max="100" step="0.5" bind:value={controlsPHOffset} /></label>
              <label class="a2-field"><span>V anchor</span>
                <select name="controls_position_p_v_anchor" bind:value={controlsPVAnchor}>
                  <option value="">Inherit</option>
                  <option value="top">From top</option>
                  <option value="bottom">From bottom</option>
                  <option value="center">Centered</option>
                </select>
              </label>
              <label class="a2-field"><span>V offset %</span><input type="number" name="controls_position_p_v_offset" min="0" max="100" step="0.5" bind:value={controlsPVOffset} /></label>
              <span class="a2-position-axis-label">Landscape</span>
              <label class="a2-field"><span>H anchor</span>
                <select name="controls_position_l_h_anchor" bind:value={controlsLHAnchor}>
                  <option value="">Inherit</option>
                  <option value="right">From right</option>
                  <option value="left">From left</option>
                  <option value="center">Centered</option>
                </select>
              </label>
              <label class="a2-field"><span>H offset %</span><input type="number" name="controls_position_l_h_offset" min="0" max="100" step="0.5" bind:value={controlsLHOffset} /></label>
              <label class="a2-field"><span>V anchor</span>
                <select name="controls_position_l_v_anchor" bind:value={controlsLVAnchor}>
                  <option value="">Inherit</option>
                  <option value="top">From top</option>
                  <option value="bottom">From bottom</option>
                  <option value="center">Centered</option>
                </select>
              </label>
              <label class="a2-field"><span>V offset %</span><input type="number" name="controls_position_l_v_offset" min="0" max="100" step="0.5" bind:value={controlsLVOffset} /></label>
            </div>
          </details>
          <!-- Calibration preview: 16:9 stage; the dot is the MAVERO
               Landscape control, the corner marker is the provider's typical
               fullscreen control position for reference. -->
          <div class="a2-position-preview" role="img" aria-label="Preview of the Landscape control placement inside the player viewport">
            <span class="a2-position-preview-provider" aria-hidden="true"></span>
            <span class="a2-position-preview-dot" aria-hidden="true" style={`${controlsPreviewHStyle};${controlsPreviewVStyle}`}></span>
            <span class="a2-position-preview-caption" aria-hidden="true">Landscape control preview</span>
          </div>
          <button type="button" class="a2-btn-secondary" onclick={resetControlsPosition}>Reset to default</button>
        {/if}
      </AdminFormSection>
      <div class="a2-form-actions">
        <button type="submit" class="a2-btn-primary">{editingSource ? 'Save' : 'Create'}</button>
        <button type="button" class="a2-btn-secondary" onclick={closeSourceSheet}>Cancel</button>
      </div>
    </form>
  </AdminSheet>
{/if}

<style>
  .a2-notice { display: inline-flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-green-soft); border: 1px solid var(--a2-green-border); border-radius: var(--a2-radius-sm); color: var(--a2-green); font-size: var(--a2-text-sm); }
  .a2-form-error { padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-sm); color: var(--a2-red); font-size: var(--a2-text-sm); }
  .a2-defaults-btn { display: inline-flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-2) var(--a2-space-4); background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-sm); font-weight: 600; cursor: pointer; }
  .a2-defaults-btn:hover { background: var(--a2-cyan-soft); border-color: var(--a2-cyan); color: var(--a2-cyan); }
  .a2-empty { display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-8); text-align: center; color: var(--a2-text-muted); }
  .a2-empty h3 { margin: 0; font-size: var(--a2-text-base); color: var(--a2-text); }
  .a2-empty p { margin: 0; font-size: var(--a2-text-sm); max-width: 420px; }

  .a2-provider-list, .a2-source-list { display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .a2-provider-row, .a2-source-row { display: flex; justify-content: space-between; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-3) var(--a2-space-4); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); }
  .a2-provider-row[data-enabled="false"], .a2-source-row[data-enabled="false"] { opacity: 0.6; }
  .a2-provider-row-main, .a2-source-row-main { display: flex; align-items: center; gap: var(--a2-space-3); min-width: 0; }
  .a2-provider-row-icon, .a2-source-row-icon { font-size: 20px; flex-shrink: 0; }
  .a2-provider-row-info, .a2-source-row-info { min-width: 0; }
  .a2-provider-row-name, .a2-source-row-name { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); }
  .a2-provider-row-meta, .a2-source-row-meta { display: flex; gap: var(--a2-space-1); font-size: var(--a2-text-2xs); color: var(--a2-text-muted); flex-wrap: wrap; }
  .a2-provider-row-actions, .a2-source-row-actions { display: flex; align-items: center; gap: var(--a2-space-1); flex-shrink: 0; }
  .a2-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; min-width: 44px; min-height: 44px; border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); background: var(--a2-surface-3); color: var(--a2-text-muted); cursor: pointer; transition: all 140ms ease-out; }
  .a2-icon-btn:hover { color: var(--a2-cyan); border-color: var(--a2-cyan-border); }
  .a2-icon-btn-danger:hover { color: var(--a2-red); border-color: var(--a2-red-border); }

  .a2-overlay { position: fixed; inset: 0; z-index: 80; background: rgba(0,0,0,0.55); backdrop-filter: blur(2px); display: flex; justify-content: flex-end; }
  .a2-sheet { width: 100%; max-width: 480px; background: var(--a2-surface-1); border-left: 1px solid var(--a2-border-strong); display: flex; flex-direction: column; overflow-y: auto; }
  .a2-sheet-head { display: flex; justify-content: space-between; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-4); padding-top: env(safe-area-inset-top, 0px); border-bottom: 1px solid var(--a2-border); position: sticky; top: 0; background: var(--a2-surface-1); z-index: 1; }
  .a2-sheet-title { display: inline-flex; align-items: center; gap: var(--a2-space-2); margin: 0; font-size: var(--a2-text-base); font-weight: 700; color: var(--a2-text-bright); }
  .a2-sheet-close { background: transparent; border: none; cursor: pointer; color: var(--a2-text-muted); padding: 4px; min-width: 44px; min-height: 44px; border-radius: var(--a2-radius-xs); }
  .a2-sheet-body { padding: var(--a2-space-4); padding-bottom: env(safe-area-inset-bottom, 0px); display: flex; flex-direction: column; gap: var(--a2-space-4); }
  .a2-sheet-desc { margin: 0 0 var(--a2-space-2); font-size: var(--a2-text-sm); color: var(--a2-text-muted); line-height: 1.5; }
  .a2-default-row { display: flex; flex-direction: column; gap: var(--a2-space-2); padding: var(--a2-space-3); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); }
  .a2-default-row-label { display: flex; justify-content: space-between; align-items: center; }
  .a2-default-row-type { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); }
  .a2-default-row-current { font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }
  .a2-default-row-none { color: var(--a2-text-dim); font-style: italic; }
  .a2-default-row-control { display: flex; gap: var(--a2-space-1); align-items: center; }
  .a2-default-select { flex: 1; background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-xs); padding: 8px 10px; min-height: 44px; }
  .a2-default-save { padding: 8px 14px; background: var(--a2-cyan); color: var(--a2-surface-1); border: none; border-radius: var(--a2-radius-sm); font-size: var(--a2-text-2xs); font-weight: 600; cursor: pointer; min-height: 44px; }
  .a2-default-clear { padding: 8px 14px; background: var(--a2-surface-4); color: var(--a2-text-muted); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); font-size: var(--a2-text-2xs); font-weight: 600; cursor: pointer; min-height: 44px; }

  .a2-crud-form { display: flex; flex-direction: column; gap: var(--a2-space-4); }
  .a2-field { display: flex; flex-direction: column; gap: 2px; }
  .a2-field span { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .a2-field input, .a2-field select { background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-sm); padding: 6px 10px; }
  .a2-field input:focus, .a2-field select:focus { outline: none; border-color: var(--a2-cyan); }
  .a2-form-actions { display: flex; gap: var(--a2-space-2); justify-content: flex-end; padding-top: var(--a2-space-3); border-top: 1px solid var(--a2-border); }
  .a2-btn-primary { padding: 10px 16px; background: var(--a2-cyan); color: var(--a2-surface-1); border: none; border-radius: var(--a2-radius-sm); font-size: var(--a2-text-sm); font-weight: 600; cursor: pointer; min-height: 44px; }
  .a2-btn-secondary { padding: 10px 16px; background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-sm); font-weight: 600; cursor: pointer; min-height: 44px; }

  .mono { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); }

  /* Player Controls Position section (player redesign). */
  .a2-field-hint { margin: 0; font-size: var(--a2-text-2xs); color: var(--a2-text-muted); line-height: 1.5; }
  .a2-position-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--a2-space-2); align-items: end; }
  .a2-position-axis-label { font-size: var(--a2-text-2xs); font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--a2-text-dim); padding-top: var(--a2-space-2); }
  .a2-position-overrides { border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); padding: var(--a2-space-2) var(--a2-space-3); }
  .a2-position-overrides summary { cursor: pointer; font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }
  .a2-position-preview { position: relative; aspect-ratio: 16 / 9; border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-sm); background: linear-gradient(160deg, #0c0c14, #16161f); overflow: hidden; }
  .a2-position-preview-provider { position: absolute; right: 8%; bottom: 10%; width: 18px; height: 10px; border: 1px dashed rgba(255,255,255,.35); border-radius: 2px; }
  .a2-position-preview-dot { position: absolute; width: 14px; height: 14px; border-radius: 50%; background: var(--a2-cyan); box-shadow: 0 0 0 4px rgba(0,0,0,.35), 0 0 10px var(--a2-cyan); }
  .a2-position-preview-caption { position: absolute; left: 8px; top: 6px; font-size: 9px; letter-spacing: .08em; text-transform: uppercase; color: rgba(255,255,255,.45); }

  @media (max-width: 768px) {
    .a2-sheet { max-width: 100%; }
    .a2-provider-row, .a2-source-row { flex-direction: column; align-items: stretch; }
    .a2-provider-row-actions, .a2-source-row-actions { justify-content: flex-end; }
    .a2-default-row-control { flex-wrap: wrap; }
  }
</style>
