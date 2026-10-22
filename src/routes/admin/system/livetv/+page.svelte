<script lang="ts">
  /**
   * Admin 2.0 — Unified Live TV management workspace (Phase 4).
   *
   * Five tabs over the unified livetv_* model:
   *   overview  — source health, config state, recent (instance-local) refresh outcomes
   *   sources   — playback source CRUD, enablement, deterministic priority, refresh/preview
   *   entries   — imported source channels: enable/disable + canonical mapping + endpoints
   *   channels  — canonical channels: CRUD, exposure, per-channel playback-candidate priority
   *   epg       — EPG source CRUD, refresh/preview, explicit mappings, guide diagnostics
   *
   * CONVENTIONS: AdminAppShell + AdminPage + AdminSheet + AdminConfirmDialog
   * + AdminStatusBadge (no competing dialog/toast/form patterns); every
   * mutation is a server action (use:enhance); deletes confirm with impact.
   * SOURCE TYPES ≠ PLAYBACK ENGINES: a playback engine is never a source
   * here — engines are derived from the typed endpoint kind (registry
   * contract), and the release-audit engine-name isolation is respected.
   */

  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { enhance } from '$app/forms';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminStatus from '$lib/components/admin2/AdminStatus.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import AdminSheet from '$lib/components/admin/AdminSheet.svelte';
  import AdminFormSection from '$lib/components/admin/AdminFormSection.svelte';
  import AdminConfirmDialog from '$lib/components/admin2/AdminConfirmDialog.svelte';
  import { Tv, Plus, RefreshCw, Eye, Pencil, Trash2, Power, Link2, Unlink2, ListPlus } from 'lucide-svelte';
  import type { PageData, ActionData } from './$types';
  // Type-only import (erased at build) for the channel editor state.
  import type { LivetvAdminChannelRow, LivetvAdminSourceRow, LivetvAdminEpgSourceRow } from '$lib/server/livetv/admin-service';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const VALID_TABS = ['overview', 'sources', 'entries', 'channels', 'epg'] as const;
  // svelte-ignore state_referenced_locally
  let currentTab = $state<string>(VALID_TABS.includes(data.tab as (typeof VALID_TABS)[number]) ? data.tab : 'overview');

  $effect(() => {
    const urlTab = page.url.searchParams.get('tab') ?? 'overview';
    if (VALID_TABS.includes(urlTab as (typeof VALID_TABS)[number]) && urlTab !== currentTab) {
      currentTab = urlTab;
    }
  });

  function switchTab(tab: string) {
    if (!VALID_TABS.includes(tab as (typeof VALID_TABS)[number]) || tab === currentTab) return;
    currentTab = tab;
    goto(`/admin/system/livetv?tab=${tab}`, { replaceState: true, noScroll: true, invalidateAll: false });
  }

  const tabs = VALID_TABS.map((tab) => ({
    id: tab,
    label: tab === 'epg' ? 'EPG Guides' : tab === 'entries' ? 'Imported Channels' : tab === 'channels' ? 'Canonical Channels' : tab === 'sources' ? 'Playback Sources' : 'Overview',
    onclick: () => switchTab(tab),
    active: currentTab === tab
  }));

  // --- shared vocabularies (display-only; the server validates everything) ---
  const SOURCE_TYPE_LABELS: Record<string, string> = {
    builtin_livegt_v1: 'Built-in LiveGT V1',
    m3u_playlist: 'Playlist (M3U/M3U8)',
    api_provider: 'API catalogue',
    embed_provider: 'Embed provider',
    manual_stream: 'Manual direct stream'
  };
  const SOURCE_STATUS_LABELS: Record<string, string> = {
    active: 'Active',
    disabled: 'Disabled',
    maintenance: 'Maintenance',
    experimental: 'Experimental',
    unavailable: 'Unavailable'
  };
  const SOURCE_STATUSES = ['active', 'experimental', 'maintenance', 'disabled', 'unavailable'];
  const CREATE_TYPES = ['m3u_playlist', 'api_provider', 'embed_provider', 'manual_stream'];

  function statusTone(status: string): 'good' | 'neutral' | 'warn' | 'bad' | 'info' {
    if (status === 'active') return 'good';
    if (status === 'experimental' || status === 'maintenance') return 'info';
    if (status === 'disabled') return 'neutral';
    return 'bad';
  }

  function formatCount(value: number | null | undefined): string {
    return value === null || value === undefined ? '—' : String(value);
  }

  function formatTime(iso: string | null | undefined): string {
    if (!iso) return '—';
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return '—';
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }

  function formatMs(ms: number | null | undefined): string {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }

  // --- sheet/dialog state ---
  let sourceSheetOpen = $state(false);
  let editingSource: LivetvAdminSourceRow | null = $state(null);
  let channelSheetOpen = $state(false);
  let editingChannel: LivetvAdminChannelRow | null = $state(null);
  let epgSheetOpen = $state(false);
  let editingEpg: LivetvAdminEpgSourceRow | null = $state(null);
  let createEndpointEntryId = $state<string | null>(null);
  let endpointKindDraft = $state<'direct_stream' | 'embed_page'>('direct_stream');

  type DeleteTarget = { kind: 'source' | 'channel' | 'epg' | 'endpoint'; id: string; name: string; impact: string };
  let pendingDelete = $state<DeleteTarget | null>(null);
  let deleteFormEl: HTMLFormElement | undefined = $state(undefined);

  function openDelete(target: DeleteTarget) {
    pendingDelete = target;
  }
  function confirmDelete() {
    deleteFormEl?.requestSubmit();
    pendingDelete = null;
  }

  function openCreateSource() {
    editingSource = null;
    sourceSheetOpen = true;
  }
  function openEditSource(source: LivetvAdminSourceRow) {
    editingSource = source;
    sourceSheetOpen = true;
  }
  function openCreateChannel() {
    editingChannel = null;
    channelSheetOpen = true;
  }
  function openEditChannel(channel: LivetvAdminChannelRow) {
    editingChannel = channel;
    channelSheetOpen = true;
  }
  function openCreateEpg() {
    editingEpg = null;
    epgSheetOpen = true;
  }
  function openEditEpg(epgSource: LivetvAdminEpgSourceRow) {
    editingEpg = epgSource;
    epgSheetOpen = true;
  }
  function closeSheets() {
    sourceSheetOpen = false;
    channelSheetOpen = false;
    epgSheetOpen = false;
    editingSource = null;
    editingChannel = null;
    editingEpg = null;
    createEndpointEntryId = null;
  }

  /** Query-string builders (bounded params; the load validates them). */
  function entryPageUrl(params: Record<string, string | number | null | undefined>): string {
    const search = new URLSearchParams({ tab: 'entries' });
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined && value !== '') search.set(key, String(value));
    }
    return `/admin/system/livetv?${search.toString()}`;
  }
  function channelPageUrl(params: Record<string, string | number | null | undefined>): string {
    const search = new URLSearchParams({ tab: 'channels' });
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined && value !== '') search.set(key, String(value));
    }
    return `/admin/system/livetv?${search.toString()}`;
  }
  function epgPageUrl(params: Record<string, string | number | null | undefined>): string {
    const search = new URLSearchParams({ tab: 'epg' });
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined && value !== '') search.set(key, String(value));
    }
    return `/admin/system/livetv?${search.toString()}`;
  }

  /** Refresh-kind guard for the outcome render blocks (ActionData is a union). */
  let lastRefreshKind = $derived(form && 'refreshKind' in form ? String((form as { refreshKind: string }).refreshKind) : null);
</script>

<svelte:head>
  <title>Live TV — Admin — Mavero</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell>
  <AdminPage eyebrow="Mavero / System" title="Live TV" accent="cyan" {tabs}>
    {#snippet description()}
      <p>
        Unified Live TV management: playback sources, imported channels,
        canonical mappings and EPG guide data. The user-facing /live-tv page is
        governed by the master enablement switch and is unaffected by this
        workspace.
      </p>
    {/snippet}

    {#if form?.notice}
      <div class="notice notice-ok" role="status">{form.notice}</div>
    {:else if form?.message}
      <div class="notice notice-error" role="alert">{form.message}</div>
    {/if}

    {#if currentTab === 'overview'}
      <section class="a2-grid a2-cards-4">
        <div class="a2-stat">
          <div class="a2-stat-value">{formatCount(data.overview?.sources.total)}</div>
          <div class="a2-stat-label">Playback sources</div>
          <div class="a2-stat-sub">{formatCount(data.overview?.sources.enabled)} enabled</div>
        </div>
        <div class="a2-stat">
          <div class="a2-stat-value">{formatCount(data.overview?.entries.total)}</div>
          <div class="a2-stat-label">Imported channels</div>
          <div class="a2-stat-sub">{formatCount(data.overview?.entries.mapped)} mapped to canonical</div>
        </div>
        <div class="a2-stat">
          <div class="a2-stat-value">{formatCount(data.overview?.channels.total)}</div>
          <div class="a2-stat-label">Canonical channels</div>
          <div class="a2-stat-sub">{formatCount(data.overview?.channels.enabled)} enabled · {formatCount(data.overview?.candidates.total)} candidates</div>
        </div>
        <div class="a2-stat">
          <div class="a2-stat-value">{formatCount(data.overview?.epg.sources)}</div>
          <div class="a2-stat-label">EPG sources</div>
          <div class="a2-stat-sub">{formatCount(data.overview?.epg.mappings)} mappings · {formatCount(data.overview?.epg.programmes)} programmes</div>
        </div>
      </section>

      <section class="a2-section">
        <div class="a2-row-head">
          <h2 class="a2-h2">System state</h2>
          {#if data.overview?.unifiedEnabled === false}
            <AdminStatus label="Unified playback disabled (rollback lever)" tone="amber" />
          {:else if data.overview?.unifiedEnabled === true}
            <AdminStatus label="Unified playback ENABLED" tone="green" />
          {:else}
            <AdminStatus label="Config state unknown" tone="amber" />
          {/if}
        </div>
        <p class="a2-muted">
          Config version <strong>v{formatCount(data.overview?.configVersion)}</strong> — bumped automatically on every mutation. The
          <code>unified_enabled</code> switch is READ-ONLY in this workspace by design (the primary rollback lever; flipping it is an
          explicit owner operation, never an admin-page side effect).
        </p>
        {#if data.overview}
          <div class="a2-chip-row">
            {#each Object.entries(data.overview.sources.byType) as [type, count]}
              <span class="a2-chip">{SOURCE_TYPE_LABELS[type] ?? type}: {count}</span>
            {/each}
            <span class="a2-chip">Endpoints: {formatCount(data.overview.endpoints.total)}</span>
          </div>
        {/if}
      </section>

      <section class="a2-section">
        <div class="a2-row-head">
          <h2 class="a2-h2">Recent refresh activity</h2>
          <AdminStatusBadge label="instance-local (per server instance)" tone="info" />
        </div>
        <p class="a2-muted">
          Report-only, bounded, per-instance records — NOT persistent history (the P2-8 proposal remains deferred to the scheduling
          phase). An instance without recent activity reports none.
        </p>
        {#if data.sourceOutcomes.length === 0 && data.epgOutcomes.length === 0}
          <p class="a2-muted">No refresh has run on this instance yet. Trigger one from the Playback Sources or EPG Guides tab.</p>
        {:else}
          <div class="a2-table-wrap">
            <table class="a2-table">
              <thead>
                <tr><th>When (UTC)</th><th>Target</th><th>Result</th><th>Counts</th></tr>
              </thead>
              <tbody>
                {#each data.sourceOutcomes as outcome}
                  <tr>
                    <td>{formatTime(outcome.finishedAt)}</td>
                    <td>source · {outcome.slug}</td>
                    <td>
                      {#if outcome.ok}
                        <AdminStatusBadge label="ok" tone="good" />
                      {:else if outcome.failure}
                        <AdminStatusBadge label={outcome.failure.kind} tone="bad" />
                      {/if}
                    </td>
                    <td>{outcome.failure ? outcome.failure.message : outcome.counts ? `${outcome.counts.discovered} discovered · ${outcome.counts.entriesInserted}+${outcome.counts.entriesUpdated} entries · ${outcome.counts.endpointsInserted}+${outcome.counts.endpointsUpdated} endpoints` : '—'}</td>
                  </tr>
                {/each}
                {#each data.epgOutcomes as outcome}
                  <tr>
                    <td>{formatTime(outcome.finishedAt)}</td>
                    <td>EPG · {outcome.slug}</td>
                    <td>
                      {#if outcome.ok}
                        <AdminStatusBadge label="ok" tone="good" />
                      {:else if outcome.failure}
                        <AdminStatusBadge label={outcome.failure.kind} tone="bad" />
                      {/if}
                    </td>
                    <td>{outcome.failure ? outcome.failure.message : outcome.counts ? `${outcome.counts.programmesDiscovered} programmes · ${outcome.counts.channelsMatched}/${outcome.counts.guideChannels} guide channels matched` : '—'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>
    {/if}

    {#if currentTab === 'sources'}
      <div class="a2-toolbar">
        <button type="button" class="a2-btn a2-btn-primary" onclick={openCreateSource}><Plus size={15} /> Add source</button>
        <form method="POST" action="?/refreshAllSources" use:enhance>
          <button type="submit" class="a2-btn"><RefreshCw size={15} /> Refresh all eligible</button>
        </form>
      </div>

      <!-- Priority inputs associate with this OUTSIDE form via the HTML5
           `form` attribute — wrapping the table in a <form> would nest it
           inside the per-row action forms (invalid HTML + hydration break). -->
      <form id="livetv-priority-form" method="POST" action="?/reorderSources" use:enhance></form>
      <div class="a2-table-wrap">
          <table class="a2-table">
            <thead>
              <tr>
                <th>Priority</th><th>Source</th><th>Type</th><th>Status</th><th>Entries</th><th>Visibility</th><th>Updated</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {#each data.sources as source (source.id)}
                <tr>
                  <td>
                    <input class="a2-input a2-input-num" type="number" form="livetv-priority-form" name="priority_{source.id}" value={source.priority} min="0" max="100000" step="1" aria-label="Priority for {source.name}" />
                  </td>
                  <td>
                    <div class="a2-cell-title">{source.name} {#if source.builtin}<span class="a2-chip">built-in</span>{/if}</div>
                    <div class="a2-cell-sub">{source.slug}</div>
                  </td>
                  <td>{SOURCE_TYPE_LABELS[source.source_type] ?? source.source_type}</td>
                  <td><AdminStatusBadge label={SOURCE_STATUS_LABELS[source.status] ?? source.status} tone={statusTone(source.status)} /></td>
                  <td>{formatCount(source.entry_count)}</td>
                  <td>{source.visibility}</td>
                  <td class="a2-dim">{formatTime(source.updated_at)}</td>
                  <td class="a2-actions">
                    <form method="POST" action="?/toggleSource" use:enhance>
                      <input type="hidden" name="id" value={source.id} />
                      <input type="hidden" name="enabled" value={source.enabled ? 'false' : 'true'} />
                      <button type="submit" class="a2-icon-btn" title={source.enabled ? 'Disable source' : 'Enable source'} aria-label={source.enabled ? 'Disable source' : 'Enable source'}>
                        <Power size={14} />
                      </button>
                    </form>
                    <button type="button" class="a2-icon-btn" title="Edit source" aria-label="Edit source" onclick={() => openEditSource(source)}><Pencil size={14} /></button>
                    <button type="button" class="a2-icon-btn" title="Delete source" aria-label="Delete source" disabled={source.builtin} onclick={() => {
                      const impact = data.impacts?.get(source.id);
                      openDelete({
                        kind: 'source',
                        id: source.id,
                        name: source.name,
                        impact: `Deletes this source and its ${formatCount(impact?.entries)} imported channel entries, ${formatCount(impact?.endpoints)} endpoints and ${formatCount(impact?.candidates)} playback-candidate rows (cascade). This cannot be undone.`
                      });
                    }}><Trash2 size={14} /></button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
      </div>
      <div class="a2-toolbar">
        <button type="submit" class="a2-btn" form="livetv-priority-form">Save priority order</button>
        <span class="a2-muted">Lower priority is attempted first (deterministic default ordering; a channel with explicit candidates ignores source priority).</span>
      </div>

      <section class="a2-section">
        <h2 class="a2-h2">Refresh results (last action)</h2>
        {#if form && 'refreshKind' in form && form.refreshKind === 'source' && 'outcome' in form && form.outcome}
          {@const outcome = form.outcome}
          {#if outcome.ok && outcome.counts && 'discovered' in outcome.counts}
            <p class="a2-muted">
              Refresh ok — {outcome.counts.discovered} discovered · {outcome.counts.entriesInserted} inserted / {outcome.counts.entriesUpdated} updated entries ·
              {outcome.counts.endpointsInserted} inserted / {outcome.counts.endpointsUpdated} updated endpoints ·
              {outcome.counts.skipped} skipped · {outcome.counts.failed} write failures.
            </p>
            {#if 'skippedReasons' in outcome && outcome.skippedReasons && Object.keys(outcome.skippedReasons).length > 0}
              <div class="a2-chip-row">
                {#each Object.entries(outcome.skippedReasons).slice(0, 6) as [reason, count]}
                  <span class="a2-chip">{reason}: {count}</span>
                {/each}
              </div>
            {/if}
          {:else if outcome.failure}
            <div class="notice notice-error" role="alert">Refresh failed — {outcome.failure.kind}: {outcome.failure.message}</div>
          {/if}
        {:else if form && 'refreshKind' in form && form.refreshKind === 'source' && 'batchOutcome' in form && form.batchOutcome}
          <p class="a2-muted">
            Batch refresh — {form.batchOutcome.refreshedSources}/{form.batchOutcome.eligibleSources} sources refreshed in {form.batchOutcome.durationMs} ms.
          </p>
        {:else}
          <p class="a2-muted">Run Refresh or Preview on a source; typed results appear here (failures include a safe failure kind — never an upstream URL).</p>
        {/if}
      </section>
    {/if}

    {#if currentTab === 'entries'}
      <form method="GET" action="/admin/system/livetv" class="a2-toolbar a2-filter-row">
        <input type="hidden" name="tab" value="entries" />
        <select class="a2-input" name="source" aria-label="Filter by source">
          <option value="">All sources</option>
          {#each data.sources as source (source.id)}
            <option value={source.id} selected={data.entryFilter?.source === source.id}>{source.name}</option>
          {/each}
        </select>
        <select class="a2-input" name="state" aria-label="Filter by mapping state">
          <option value="all" selected={data.entryFilter?.state === 'all'}>All entries</option>
          <option value="mapped" selected={data.entryFilter?.state === 'mapped'}>Mapped</option>
          <option value="unmapped" selected={data.entryFilter?.state === 'unmapped'}>Unmapped</option>
        </select>
        <input class="a2-input" type="search" name="q" value={data.entryFilter?.q ?? ''} placeholder="Search by name…" maxlength="80" aria-label="Search entries" />
        <button type="submit" class="a2-btn">Filter</button>
      </form>

      <p class="a2-muted">{formatCount(data.entries?.total)} entries · page {(data.entries?.page ?? 0) + 1} ({data.entries?.pageSize}/page)</p>

      <div class="a2-table-wrap">
        <table class="a2-table">
          <thead>
            <tr><th>Entry</th><th>Source</th><th>tvg_id</th><th>Mapping</th><th>Enabled</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {#each data.entries?.rows ?? [] as entry (entry.id)}
              <tr>
                <td>
                  <div class="a2-cell-title">{entry.name}</div>
                  <div class="a2-cell-sub">{entry.source_channel_id}{entry.category ? ` · ${entry.category}` : ''}</div>
                </td>
                <td>{data.sources?.find((source) => source.id === entry.source_id)?.name ?? entry.source_id.slice(0, 8)}</td>
                <td class="a2-dim">{entry.tvg_id ?? '—'}</td>
                <td>
                  <form method="POST" action="?/mapEntry" use:enhance class="a2-inline-form">
                    <input type="hidden" name="id" value={entry.id} />
                    <select class="a2-input a2-input-select" name="channelId" aria-label="Canonical mapping for {entry.name}">
                      <option value="">— unmapped —</option>
                      {#each data.channels?.rows ?? [] as channel (channel.id)}
                        <option value={channel.id} selected={entry.canonical_channel_id === channel.id}>{channel.name}</option>
                      {/each}
                    </select>
                    <button type="submit" class="a2-btn a2-btn-sm">Map</button>
                  </form>
                </td>
                <td><AdminStatusBadge label={entry.enabled ? 'enabled' : 'disabled'} tone={entry.enabled ? 'good' : 'neutral'} /></td>
                <td class="a2-actions">
                  <a class="a2-icon-btn" title="Inspect endpoints" aria-label="Inspect endpoints for {entry.name}" href={entryPageUrl({ source: data.entryFilter?.source, state: data.entryFilter?.state, q: data.entryFilter?.q, page: data.entryFilter?.page, entry: entry.id })}><ListPlus size={14} /></a>
                  <form method="POST" action="?/toggleEntry" use:enhance>
                    <input type="hidden" name="id" value={entry.id} />
                    <input type="hidden" name="enabled" value={entry.enabled ? 'false' : 'true'} />
                    <button type="submit" class="a2-icon-btn" title={entry.enabled ? 'Disable entry' : 'Enable entry'} aria-label={entry.enabled ? 'Disable entry' : 'Enable entry'}><Power size={14} /></button>
                  </form>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="a2-toolbar">
        {#if (data.entries?.page ?? 0) > 0}
          <a class="a2-btn" href={entryPageUrl({ source: data.entryFilter?.source, state: data.entryFilter?.state, q: data.entryFilter?.q, page: (data.entries?.page ?? 0) - 1 })}>Previous</a>
        {/if}
        {#if data.entries && (data.entries.page + 1) * data.entries.pageSize < data.entries.total}
          <a class="a2-btn" href={entryPageUrl({ source: data.entryFilter?.source, state: data.entryFilter?.state, q: data.entryFilter?.q, page: (data.entries?.page ?? 0) + 1 })}>Next</a>
        {/if}
      </div>

      {#if data.entryEndpoints}
        <section class="a2-section a2-inspector">
          <div class="a2-row-head">
            <h2 class="a2-h2">Endpoints — {data.entryEndpoints.entry.name}</h2>
            <a class="a2-btn a2-btn-sm" href={entryPageUrl({ source: data.entryFilter?.source, state: data.entryFilter?.state, q: data.entryFilter?.q, page: data.entryFilter?.page })}>Close inspector</a>
          </div>
          <p class="a2-muted">
            Source type: {SOURCE_TYPE_LABELS[data.entryEndpoints.sourceType ?? ''] ?? data.entryEndpoints.sourceType}.
            {#if data.entryEndpoints.adminAuthored}
              This source has no upstream catalogue adapter — endpoints are admin-authored (add/edit/delete available).
            {:else}
              Endpoints of adapter-fed sources are owned by the source refresh: enablement and ordering are admin-owned and persist; URL/kind edits and deletes would be undone by the next refresh and are refused.
            {/if}
          </p>
          <div class="a2-table-wrap">
            <table class="a2-table">
              <thead><tr><th>Kind</th><th>Format</th><th>URL</th><th>Order</th><th>Enabled</th><th>Actions</th></tr></thead>
              <tbody>
                {#each data.entryEndpoints.endpoints as endpoint (endpoint.id)}
                  <tr>
                    <td>{endpoint.endpoint_kind}</td>
                    <td>{endpoint.stream_format ?? '—'}</td>
                    <td class="a2-url">{endpoint.url}</td>
                    <td>{endpoint.ordering}</td>
                    <td><AdminStatusBadge label={endpoint.enabled ? 'enabled' : 'disabled'} tone={endpoint.enabled ? 'good' : 'neutral'} /></td>
                    <td class="a2-actions">
                      <form method="POST" action="?/toggleEndpoint" use:enhance>
                        <input type="hidden" name="id" value={endpoint.id} />
                        <input type="hidden" name="enabled" value={endpoint.enabled ? 'false' : 'true'} />
                        <button type="submit" class="a2-icon-btn" title={endpoint.enabled ? 'Disable endpoint' : 'Enable endpoint'} aria-label="Toggle endpoint"><Power size={14} /></button>
                      </form>
                      {#if data.entryEndpoints?.adminAuthored}
                        <button type="button" class="a2-icon-btn" title="Delete endpoint" aria-label="Delete endpoint" onclick={() => openDelete({ kind: 'endpoint', id: endpoint.id, name: endpoint.url, impact: 'Deletes this endpoint and any playback candidates referencing it (cascade). This cannot be undone.' })}><Trash2 size={14} /></button>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if data.entryEndpoints.adminAuthored}
            <div class="a2-toolbar">
              <button type="button" class="a2-btn a2-btn-primary" onclick={() => { createEndpointEntryId = data.entryEndpoints?.entry.id ?? null; endpointKindDraft = 'direct_stream'; }}><Plus size={15} /> Add endpoint</button>
            </div>
          {/if}
        </section>
      {/if}
    {/if}

    {#if currentTab === 'channels'}
      <div class="a2-toolbar">
        <button type="button" class="a2-btn a2-btn-primary" onclick={openCreateChannel}><Plus size={15} /> Add canonical channel</button>
        <form method="GET" action="/admin/system/livetv" class="a2-inline-form">
          <input type="hidden" name="tab" value="channels" />
          <input class="a2-input" type="search" name="q" value={data.channelFilter?.q ?? ''} placeholder="Search channels…" maxlength="80" aria-label="Search canonical channels" />
          <button type="submit" class="a2-btn">Search</button>
        </form>
      </div>

      <p class="a2-muted">{formatCount(data.channels?.total)} channels · page {(data.channels?.page ?? 0) + 1} ({data.channels?.pageSize}/page)</p>

      <div class="a2-table-wrap">
        <table class="a2-table">
          <thead>
            <tr><th>Channel</th><th>Category</th><th>Entries</th><th>Candidates</th><th>EPG mappings</th><th>Enabled</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {#each data.channels?.rows ?? [] as channel (channel.id)}
              <tr>
                <td>
                  <div class="a2-cell-title">{channel.name}</div>
                  <div class="a2-cell-sub">{channel.dedup_key ?? 'no dedup key'}</div>
                </td>
                <td>{channel.category ?? '—'}</td>
                <td>{formatCount(channel.entry_count)}</td>
                <td>{formatCount(channel.candidate_count)}</td>
                <td>{formatCount(channel.epg_mapping_count)}</td>
                <td><AdminStatusBadge label={channel.enabled ? 'enabled' : 'disabled'} tone={channel.enabled ? 'good' : 'neutral'} /></td>
                <td class="a2-actions">
                  <a class="a2-icon-btn" title="Playback candidates" aria-label="Playback candidates for {channel.name}" href={channelPageUrl({ q: data.channelFilter?.q, page: data.channelFilter?.page, channel: channel.id })}><ListPlus size={14} /></a>
                  <button type="button" class="a2-icon-btn" title="Edit channel" aria-label="Edit channel" onclick={() => openEditChannel(channel)}><Pencil size={14} /></button>
                  <form method="POST" action="?/toggleChannel" use:enhance>
                    <input type="hidden" name="id" value={channel.id} />
                    <input type="hidden" name="enabled" value={channel.enabled ? 'false' : 'true'} />
                    <button type="submit" class="a2-icon-btn" title={channel.enabled ? 'Disable channel' : 'Enable channel'} aria-label="Toggle channel"><Power size={14} /></button>
                  </form>
                  <button type="button" class="a2-icon-btn" title="Delete channel" aria-label="Delete channel" onclick={() => openDelete({
                    kind: 'channel',
                    id: channel.id,
                    name: channel.name,
                    impact: `Unmaps ${formatCount(channel.entry_count)} source entries (provenance preserved), deletes ${formatCount(channel.candidate_count)} playback-candidate rows and ${formatCount(channel.epg_mapping_count)} explicit EPG mappings (cascade). This cannot be undone.`
                  })}><Trash2 size={14} /></button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="a2-toolbar">
        {#if (data.channels?.page ?? 0) > 0}
          <a class="a2-btn" href={channelPageUrl({ q: data.channelFilter?.q, page: (data.channels?.page ?? 0) - 1 })}>Previous</a>
        {/if}
        {#if data.channels && (data.channels.page + 1) * data.channels.pageSize < data.channels.total}
          <a class="a2-btn" href={channelPageUrl({ q: data.channelFilter?.q, page: (data.channels?.page ?? 0) + 1 })}>Next</a>
        {/if}
      </div>

      {#if data.candidates}
        <section class="a2-section a2-inspector">
          <div class="a2-row-head">
            <h2 class="a2-h2">Playback priority — {data.channels?.rows.find((channel) => channel.id === data.candidates?.channelId)?.name ?? data.candidates.channelId}</h2>
            <a class="a2-btn a2-btn-sm" href={channelPageUrl({ q: data.channelFilter?.q, page: data.channelFilter?.page })}>Close inspector</a>
          </div>
          <p class="a2-muted">
            Mode: <strong>{data.candidates.mode === 'explicit' ? 'explicit candidates' : 'source-priority default'}</strong> —
            {#if data.candidates.mode === 'explicit'}
              the ordered candidate list below is authoritative for this channel (Phase 5 will dispatch along it; nothing dispatches yet).
            {:else}
              no explicit candidates exist; playback order follows source priority → entry → endpoint ordering. Adding a candidate switches this channel to explicit mode.
            {/if}
            The playback engine is DERIVED from the endpoint kind — it is never a priority entry.
          </p>

          <h3 class="a2-h3">Candidate list ({data.candidates.candidates.length})</h3>
          {#if data.candidates.candidates.length === 0}
            <p class="a2-muted">No explicit candidates — default mode.</p>
          {:else}
            <div class="a2-table-wrap">
              <table class="a2-table">
                <thead><tr><th>Priority</th><th>Endpoint</th><th>Kind</th><th>Enabled</th><th>Actions</th></tr></thead>
                <tbody>
                  {#each [...data.candidates.candidates].sort((a, b) => a.priority - b.priority) as candidate (candidate.id)}
                    {@const endpoint = data.candidates?.endpoints.find((view) => view.endpoint.id === candidate.endpoint_id)}
                    <tr>
                      <td>
                        <form method="POST" action="?/updateCandidate" use:enhance class="a2-inline-form">
                          <input type="hidden" name="channelId" value={data.candidates?.channelId} />
                          <input type="hidden" name="id" value={candidate.id} />
                          <input class="a2-input a2-input-num" type="number" name="priority" value={candidate.priority} min="0" max="100000" step="1" aria-label="Priority" />
                          <button type="submit" class="a2-btn a2-btn-sm">Save</button>
                        </form>
                      </td>
                      <td>
                        <div class="a2-cell-title">{endpoint?.sourceSlug ?? 'unknown source'} · {endpoint?.entry?.name ?? 'unlinked entry'}</div>
                        <div class="a2-cell-sub a2-url">{endpoint?.endpoint.url ?? candidate.endpoint_id}</div>
                      </td>
                      <td>{endpoint ? `${endpoint.endpoint.endpoint_kind}${endpoint.endpoint.stream_format ? ` (${endpoint.endpoint.stream_format})` : ''}` : '—'}</td>
                      <td><AdminStatusBadge label={candidate.enabled ? 'enabled' : 'disabled'} tone={candidate.enabled ? 'good' : 'neutral'} /></td>
                      <td class="a2-actions">
                        <form method="POST" action="?/updateCandidate" use:enhance>
                          <input type="hidden" name="channelId" value={data.candidates?.channelId} />
                          <input type="hidden" name="id" value={candidate.id} />
                          <input type="hidden" name="enabled" value={candidate.enabled ? 'false' : 'true'} />
                          <button type="submit" class="a2-icon-btn" title="Toggle candidate" aria-label="Toggle candidate"><Power size={14} /></button>
                        </form>
                        <form method="POST" action="?/removeCandidate" use:enhance>
                          <input type="hidden" name="channelId" value={data.candidates?.channelId} />
                          <input type="hidden" name="id" value={candidate.id} />
                          <button type="submit" class="a2-icon-btn" title="Remove candidate" aria-label="Remove candidate"><Unlink2 size={14} /></button>
                        </form>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}

          <h3 class="a2-h3">Available endpoints ({data.candidates.endpoints.length})</h3>
          <p class="a2-muted">Every typed endpoint of this channel's mapped source entries. Only endpoints of MAPPED entries can become candidates (the database trigger rejects anything else).</p>
          <div class="a2-table-wrap">
            <table class="a2-table">
              <thead><tr><th>Source</th><th>Entry</th><th>Kind</th><th>URL</th><th>Order</th><th>State</th><th>Add</th></tr></thead>
              <tbody>
                {#each data.candidates.endpoints as view (view.endpoint.id)}
                  <tr>
                    <td>{view.sourceSlug ?? '—'}</td>
                    <td>{view.entry?.name ?? '—'}</td>
                    <td>{view.endpoint.endpoint_kind}{view.endpoint.stream_format ? ` (${view.endpoint.stream_format})` : ''}</td>
                    <td class="a2-url">{view.endpoint.url}</td>
                    <td>{view.endpoint.ordering}</td>
                    <td>
                      {#if view.candidate}
                        <AdminStatusBadge label="already candidate" tone="info" />
                      {:else}
                        <AdminStatusBadge label={view.endpoint.enabled && (view.entry?.enabled ?? false) ? 'eligible' : 'gated'} tone={view.endpoint.enabled && (view.entry?.enabled ?? false) ? 'good' : 'warn'} />
                      {/if}
                    </td>
                    <td>
                      {#if !view.candidate}
                        <form method="POST" action="?/addCandidate" use:enhance class="a2-inline-form">
                          <input type="hidden" name="channelId" value={data.candidates?.channelId} />
                          <input type="hidden" name="endpointId" value={view.endpoint.id} />
                          <input class="a2-input a2-input-num" type="number" name="priority" value="100" min="0" max="100000" aria-label="Candidate priority" />
                          <button type="submit" class="a2-btn a2-btn-sm"><Link2 size={13} /> Add</button>
                        </form>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </section>
      {/if}
    {/if}

    {#if currentTab === 'epg'}
      <div class="a2-toolbar">
        <button type="button" class="a2-btn a2-btn-primary" onclick={openCreateEpg}><Plus size={15} /> Add EPG source</button>
        <form method="POST" action="?/refreshAllEpgSources" use:enhance>
          <button type="submit" class="a2-btn"><RefreshCw size={15} /> Refresh all eligible</button>
        </form>
      </div>

      <div class="a2-table-wrap">
        <table class="a2-table">
          <thead>
            <tr><th>Guide source</th><th>Type</th><th>Status</th><th>Mappings</th><th>Programmes</th><th>Updated</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {#each data.epgSources as epgSource (epgSource.id)}
              <tr>
                <td>
                  <div class="a2-cell-title">{epgSource.name}</div>
                  <div class="a2-cell-sub">{epgSource.slug}</div>
                </td>
                <td>{epgSource.epg_type}</td>
                <td>
                  <AdminStatusBadge label={SOURCE_STATUS_LABELS[epgSource.status] ?? epgSource.status} tone={statusTone(epgSource.status)} />
                  {#if !epgSource.enabled}<AdminStatusBadge label="disabled" tone="neutral" />{/if}
                </td>
                <td>{formatCount(epgSource.mapping_count)}</td>
                <td>{formatCount(epgSource.programme_count)}</td>
                <td class="a2-dim">{formatTime(epgSource.updated_at)}</td>
                <td class="a2-actions">
                  <a class="a2-icon-btn" title="Mappings + diagnostics" aria-label="Mappings and diagnostics for {epgSource.name}" href={epgPageUrl({ epg: epgSource.id })}><Eye size={14} /></a>
                  <form method="POST" action="?/refreshEpgSource" use:enhance>
                    <input type="hidden" name="id" value={epgSource.id} />
                    <button type="submit" class="a2-icon-btn" title="Refresh guide" aria-label="Refresh guide"><RefreshCw size={14} /></button>
                  </form>
                  <form method="POST" action="?/previewEpgSource" use:enhance>
                    <input type="hidden" name="id" value={epgSource.id} />
                    <button type="submit" class="a2-icon-btn" title="Preview guide (dry run)" aria-label="Preview guide"><Eye size={14} /></button>
                  </form>
                  <form method="POST" action="?/toggleEpgSource" use:enhance>
                    <input type="hidden" name="id" value={epgSource.id} />
                    <input type="hidden" name="enabled" value={epgSource.enabled ? 'false' : 'true'} />
                    <button type="submit" class="a2-icon-btn" title={epgSource.enabled ? 'Disable' : 'Enable'} aria-label="Toggle EPG source"><Power size={14} /></button>
                  </form>
                  <button type="button" class="a2-icon-btn" title="Edit EPG source" aria-label="Edit EPG source" onclick={() => openEditEpg(epgSource)}><Pencil size={14} /></button>
                  <button type="button" class="a2-icon-btn" title="Delete EPG source" aria-label="Delete EPG source" onclick={() => openDelete({
                    kind: 'epg',
                    id: epgSource.id,
                    name: epgSource.name,
                    impact: `Deletes this guide source with its ${formatCount(epgSource.mapping_count)} explicit mappings and ${formatCount(epgSource.programme_count)} stored programme rows (cascade). This cannot be undone.`
                  })}><Trash2 size={14} /></button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      {#if form && 'refreshKind' in form && form.refreshKind === 'epg' && 'outcome' in form && form.outcome}
        {@const outcome = form.outcome}
        <section class="a2-section">
          <h2 class="a2-h2">Guide refresh result</h2>
          {#if outcome.ok && outcome.counts && 'programmesDiscovered' in outcome.counts}
            <p class="a2-muted">
              Guide refresh ok — {outcome.counts.programmesDiscovered} programmes discovered ·
              {outcome.counts.programmesInserted} inserted / {outcome.counts.programmesUpdated} updated / {outcome.counts.programmesUnchanged} unchanged ·
              {outcome.counts.programmesSkippedInvalid} invalid skipped · {outcome.counts.programmesFailed} write failures ·
              retention swept {outcome.counts.retentionDeleted ?? 0} rows.
            </p>
            <p class="a2-muted">
              Mapping — {outcome.counts.channelsMatched}/{outcome.counts.guideChannels} guide channels matched
              ({outcome.counts.channelsMatchedExplicit} explicit · {outcome.counts.channelsMatchedTvgId} tvgId) ·
              {outcome.counts.channelsUnmatched} unmatched · {outcome.counts.channelsAmbiguous} ambiguous · {outcome.counts.channelsInvalidId} invalid.
              {#if 'timezonePolicy' in outcome && outcome.timezonePolicy}
                Timezone policy: {outcome.timezonePolicy.configured ? `configured (${outcome.timezonePolicy.configured})` : 'not configured'} —
                {outcome.timezonePolicy.explicitOffsetTimestamps} explicit-offset · {outcome.timezonePolicy.defaultTimezoneTimestamps} default-zone timestamps.
              {/if}
            </p>
            {#if 'mappingSamples' in outcome && outcome.mappingSamples && (outcome.mappingSamples.unmatched.length > 0 || outcome.mappingSamples.ambiguous.length > 0 || outcome.mappingSamples.invalid.length > 0)}
              <div class="a2-chip-row">
                {#each outcome.mappingSamples.unmatched.slice(0, 8) as sample}
                  <span class="a2-chip">unmatched: {sample}</span>
                {/each}
                {#each outcome.mappingSamples.ambiguous.slice(0, 8) as sample}
                  <span class="a2-chip">ambiguous: {sample}</span>
                {/each}
                {#each outcome.mappingSamples.invalid.slice(0, 8) as sample}
                  <span class="a2-chip">invalid: {sample}</span>
                {/each}
              </div>
            {/if}
          {:else if outcome.failure}
            <div class="notice notice-error" role="alert">Guide refresh failed — {outcome.failure.kind}: {outcome.failure.message}</div>
          {/if}
        </section>
      {/if}

      {#if data.selectedEpg && data.mappings}
        <section class="a2-section a2-inspector">
          <div class="a2-row-head">
            <h2 class="a2-h2">Explicit mappings — {data.epgSources.find((epgSource) => epgSource.id === data.selectedEpg)?.name ?? ''}</h2>
            <a class="a2-btn a2-btn-sm" href={epgPageUrl({})}>Close inspector</a>
          </div>

          <form method="POST" action="?/createEpgMapping" use:enhance class="a2-inline-form a2-mapping-form">
            <input type="hidden" name="epgSourceId" value={data.selectedEpg} />
            <select class="a2-input" name="channelId" aria-label="Canonical channel" required>
              <option value="">Choose canonical channel…</option>
              {#each data.channels?.rows ?? [] as channel (channel.id)}
                <option value={channel.id}>{channel.name}</option>
              {/each}
            </select>
            <input class="a2-input" type="text" name="epgChannelId" placeholder="Guide channel id (exact, case-sensitive)" maxlength="200" required aria-label="Guide channel id" />
            <button type="submit" class="a2-btn a2-btn-primary"><Plus size={14} /> Create mapping</button>
          </form>
          <p class="a2-muted">
            1:1 per guide source in both directions (database-enforced). Guide ids are normalized (NFKC + trim) and stored case-sensitively;
            display names are never used as identity.
          </p>

          <div class="a2-table-wrap">
            <table class="a2-table">
              <thead><tr><th>Guide channel id</th><th>Canonical channel</th><th>Actions</th></tr></thead>
              <tbody>
                {#each data.mappings.rows as mapping (mapping.id)}
                  <tr>
                    <td class="a2-url">{mapping.epg_channel_id}</td>
                    <td>{mapping.channel_name ?? mapping.channel_id.slice(0, 8)}</td>
                    <td>
                      <form method="POST" action="?/deleteEpgMapping" use:enhance>
                        <input type="hidden" name="epgSourceId" value={data.selectedEpg} />
                        <input type="hidden" name="id" value={mapping.id} />
                        <button type="submit" class="a2-icon-btn" title="Delete mapping" aria-label="Delete mapping"><Trash2 size={14} /></button>
                      </form>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <div class="a2-toolbar">
            {#if (data.mappings.page ?? 0) > 0}
              <a class="a2-btn" href={epgPageUrl({ epg: data.selectedEpg, mpage: (data.mappings?.page ?? 0) - 1 })}>Previous</a>
            {/if}
            {#if data.mappings && (data.mappings.page + 1) * data.mappings.pageSize < data.mappings.total}
              <a class="a2-btn" href={epgPageUrl({ epg: data.selectedEpg, mpage: (data.mappings?.page ?? 0) + 1 })}>Next</a>
            {/if}
            <span class="a2-muted">{formatCount(data.mappings.total)} mappings</span>
          </div>
        </section>
      {/if}

      {#if data.selectedEpg && data.diagnostics}
        <section class="a2-section a2-inspector">
          <h2 class="a2-h2">Guide diagnostics — {data.diagnostics.name}</h2>
          <p class="a2-muted">
            {formatCount(data.diagnostics.programmeCount)} stored programme rows ·
            {formatCount(data.diagnostics.storedGuideIds)} distinct guide identities observed in stored rows{data.diagnostics.storedGuideIdsTruncated ? ' (probe capped — refresh for exact numbers)' : ''}.
          </p>
          <div class="a2-chip-row">
            <span class="a2-chip">matched: {data.diagnostics.counts.matched}</span>
            <span class="a2-chip">explicit: {data.diagnostics.counts.viaExplicit}</span>
            <span class="a2-chip">tvgId: {data.diagnostics.counts.viaTvgId}</span>
            <span class="a2-chip">unmatched: {data.diagnostics.counts.unmatched}</span>
            <span class="a2-chip">ambiguous: {data.diagnostics.counts.ambiguous}</span>
            <span class="a2-chip">invalid: {data.diagnostics.counts.invalid}</span>
          </div>
          {#if data.diagnostics.samples.unmatched.length > 0 || data.diagnostics.samples.ambiguous.length > 0 || data.diagnostics.samples.invalid.length > 0}
            <div class="a2-chip-row">
              {#each data.diagnostics.samples.unmatched.slice(0, 8) as sample}
                <span class="a2-chip">unmatched: {sample}</span>
              {/each}
              {#each data.diagnostics.samples.ambiguous.slice(0, 8) as sample}
                <span class="a2-chip">ambiguous: {sample}</span>
              {/each}
              {#each data.diagnostics.samples.invalid.slice(0, 8) as sample}
                <span class="a2-chip">invalid: {sample}</span>
              {/each}
            </div>
          {/if}
          <div class="a2-table-wrap">
            <table class="a2-table">
              <thead><tr><th>Guide id</th><th>Match</th><th>Canonical channel</th><th>Now</th><th>Next</th></tr></thead>
              <tbody>
                {#each data.diagnostics.guide as guideRow (guideRow.epgChannelId)}
                  <tr>
                    <td class="a2-url">{guideRow.epgChannelId}</td>
                    <td>
                      <AdminStatusBadge label={guideRow.status + (guideRow.mappingSource ? ` (${guideRow.mappingSource})` : '')} tone={guideRow.status === 'matched' ? 'good' : guideRow.status === 'ambiguous' ? 'warn' : 'neutral'} />
                    </td>
                    <td>{guideRow.channelName ?? '—'}</td>
                    <td>{guideRow.currentTitle ?? '—'}</td>
                    <td>{guideRow.nextTitle ? `${guideRow.nextTitle} (${formatMs(guideRow.nextStartMs)})` : '—'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </section>
      {/if}
    {/if}

    {#if currentTab === 'sources' || currentTab === 'overview'}
      <p class="a2-footnote">
        Source types are provider identities — playlist, API catalogue, embed provider, manual direct stream and the built-in
        LiveGT V1. The DASH/HLS player engine and the iframe embed are playback METHODS derived from the typed endpoint kind;
        they are never source types and never appear in any priority list.
      </p>
    {/if}

    <!-- ==================== Source create/edit sheet ==================== -->
    <AdminSheet open={sourceSheetOpen} title={editingSource ? `Edit source — ${editingSource.name}` : 'Add playback source'} onClose={closeSheets} size="wide">
      <form method="POST" action={editingSource ? '?/updateSource' : '?/createSource'} use:enhance onsubmit={() => setTimeout(closeSheets, 0)}>
        {#if editingSource}<input type="hidden" name="id" value={editingSource.id} />{/if}
        <AdminFormSection heading="Identity" description="Slug and type are immutable after creation (slugs are stored references; the type selects the server adapter).">
          <label class="a2-field"><span>Display name *</span>
            <input class="a2-input" type="text" name="name" value={editingSource?.name ?? ''} maxlength="120" required />
          </label>
          {#if !editingSource}
            <label class="a2-field"><span>Slug (optional — derived from the name)</span>
              <input class="a2-input" type="text" name="slug" value="" maxlength="120" pattern="[a-z0-9]+(-[a-z0-9]+)*" />
            </label>
            <label class="a2-field"><span>Source type *</span>
              <select class="a2-input" name="sourceType" required>
                {#each CREATE_TYPES as type}
                  <option value={type}>{SOURCE_TYPE_LABELS[type]}</option>
                {/each}
              </select>
            </label>
          {:else}
            <input type="hidden" name="sourceType" value={editingSource.source_type} />
            <div class="a2-field"><span>Type</span><div>{SOURCE_TYPE_LABELS[editingSource.source_type] ?? editingSource.source_type}</div></div>
          {/if}
        </AdminFormSection>
        <AdminFormSection heading="Configuration" description="Server-fetched URLs are https-only and validated by the SSRF guard (stage 1) at save time and per fetch.">
          {#if (editingSource?.source_type ?? '') === 'm3u_playlist'}
            <label class="a2-field a2-field-wide"><span>Playlist URL (https) *</span>
              <input class="a2-input" type="url" name="playlistUrl" value={String((editingSource?.config as Record<string, unknown> | null)?.playlistUrl ?? '')} maxlength="2048" placeholder="https://example.com/playlist.m3u8" />
            </label>
          {/if}
          {#if (editingSource?.source_type ?? '') === 'api_provider'}
            <label class="a2-field a2-field-wide"><span>API base URL (https) *</span>
              <input class="a2-input" type="url" name="baseUrl" value={String((editingSource?.config as Record<string, unknown> | null)?.baseUrl ?? '')} maxlength="2048" placeholder="https://api.example.com" />
            </label>
          {/if}
          {#if (editingSource?.source_type ?? '') === 'embed_provider'}
            <label class="a2-field a2-field-wide"><span>Allowed embed origins (https origins, whitespace/comma separated) *</span>
              <input class="a2-input" type="text" name="allowedOrigins" value={Array.isArray((editingSource?.config as Record<string, unknown> | null)?.allowedOrigins) ? ((editingSource!.config as Record<string, unknown>).allowedOrigins as string[]).join(', ') : ''} placeholder="https://player.example.com, https://embed.example.net" />
            </label>
          {/if}
          {#if (editingSource?.source_type ?? '') === 'manual_stream' || (editingSource?.source_type ?? '') === 'builtin_livegt_v1'}
            <p class="a2-muted a2-field-wide">This source type carries no server-side config{editingSource?.source_type === 'manual_stream' ? ' — add its endpoints from the Imported Channels tab' : ' — behavior lives in the existing client modules'}.</p>
          {/if}
        </AdminFormSection>
        <AdminFormSection heading="Registry state">
          <label class="a2-field"><span>Status</span>
            <select class="a2-input" name="status">
              {#each SOURCE_STATUSES as status}
                <option value={status} selected={(editingSource?.status ?? 'experimental') === status}>{SOURCE_STATUS_LABELS[status]}</option>
              {/each}
            </select>
          </label>
          <label class="a2-field"><span>Visibility</span>
            <select class="a2-input" name="visibility">
              <option value="internal" selected={(editingSource?.visibility ?? 'internal') === 'internal'}>internal (admin diagnostics)</option>
              <option value="public" selected={editingSource?.visibility === 'public'}>public</option>
              <option value="hidden" selected={editingSource?.visibility === 'hidden'}>hidden</option>
            </select>
          </label>
          <label class="a2-field"><span>Default priority (0 = first)</span>
            <input class="a2-input" type="number" name="priority" value={editingSource?.priority ?? 100} min="0" max="100000" step="1" />
          </label>
          {#if !editingSource}
            <label class="a2-field a2-checkbox-field"><input type="checkbox" name="enabled" /> <span>Enabled immediately</span></label>
          {/if}
          <label class="a2-field a2-field-wide"><span>Description</span>
            <input class="a2-input" type="text" name="description" value={editingSource?.description ?? ''} maxlength="1000" />
          </label>
        </AdminFormSection>
        <div class="a2-toolbar">
          <button type="submit" class="a2-btn a2-btn-primary">{editingSource ? 'Save source' : 'Create source'}</button>
          <button type="button" class="a2-btn" onclick={closeSheets}>Cancel</button>
        </div>
      </form>
    </AdminSheet>

    <!-- ==================== Channel create/edit sheet ==================== -->
    <AdminSheet open={channelSheetOpen} title={editingChannel ? `Edit channel — ${editingChannel.name}` : 'Add canonical channel'} onClose={closeSheets} size="wide">
      <form method="POST" action={editingChannel ? '?/updateChannel' : '?/createChannel'} use:enhance onsubmit={() => setTimeout(closeSheets, 0)}>
        {#if editingChannel}<input type="hidden" name="id" value={editingChannel.id} />{/if}
        <AdminFormSection heading="Canonical channel" description="Display metadata lives here; source provenance stays on the imported entries. Display-name equality NEVER merges channels.">
          <label class="a2-field"><span>Name *</span>
            <input class="a2-input" type="text" name="name" value={editingChannel?.name ?? ''} maxlength="200" required />
          </label>
          <label class="a2-field"><span>Category</span>
            <input class="a2-input" type="text" name="category" value={editingChannel?.category ?? ''} maxlength="120" />
          </label>
          <label class="a2-field a2-field-wide"><span>Logo URL (https)</span>
            <input class="a2-input" type="url" name="logoUrl" value={editingChannel?.logo_url ?? ''} maxlength="2048" />
          </label>
          <label class="a2-field"><span>Dedup key (optional; 8-200 of a-z 0-9 : _ -)</span>
            <input class="a2-input" type="text" name="dedupKey" value={editingChannel?.dedup_key ?? ''} maxlength="200" />
          </label>
          <label class="a2-field a2-checkbox-field"><input type="checkbox" name="enabled" checked={editingChannel ? editingChannel.enabled : true} /> <span>Enabled (user exposure gate)</span></label>
          <label class="a2-field a2-field-wide"><span>Notes</span>
            <input class="a2-input" type="text" name="notes" value={editingChannel?.notes ?? ''} maxlength="2000" />
          </label>
        </AdminFormSection>
        <div class="a2-toolbar">
          <button type="submit" class="a2-btn a2-btn-primary">{editingChannel ? 'Save channel' : 'Create channel'}</button>
          <button type="button" class="a2-btn" onclick={closeSheets}>Cancel</button>
        </div>
      </form>
    </AdminSheet>

    <!-- ==================== EPG source create/edit sheet ==================== -->
    <AdminSheet open={epgSheetOpen} title={editingEpg ? `Edit EPG source — ${editingEpg.name}` : 'Add EPG source'} onClose={closeSheets} size="wide">
      <form method="POST" action={editingEpg ? '?/updateEpgSource' : '?/createEpgSource'} use:enhance onsubmit={() => setTimeout(closeSheets, 0)}>
        {#if editingEpg}<input type="hidden" name="id" value={editingEpg.id} />{/if}
        <AdminFormSection heading="Guide source" description="The XMLTV document is fetched server-side through the bounded SSRF-guarded fetcher (plain + gzip detected by content).">
          <label class="a2-field"><span>Display name *</span>
            <input class="a2-input" type="text" name="name" value={editingEpg?.name ?? ''} maxlength="120" required />
          </label>
          {#if !editingEpg}
            <label class="a2-field"><span>Slug (optional — derived from the name)</span>
              <input class="a2-input" type="text" name="slug" value="" maxlength="120" pattern="[a-z0-9]+(-[a-z0-9]+)*" />
            </label>
          {/if}
          <label class="a2-field a2-field-wide"><span>Guide URL (https XMLTV) *</span>
            <input class="a2-input" type="url" name="sourceUrl" value={editingEpg?.source_url ?? ''} maxlength="2048" placeholder="https://epg.example.com/guide.xml.gz" required />
          </label>
          <label class="a2-field"><span>Default timezone (IANA — for timezone-LESS timestamps only)</span>
            <input class="a2-input" type="text" name="defaultTimezone" value={String((editingEpg?.config as Record<string, unknown> | null)?.defaultTimezone ?? '')} maxlength="64" placeholder="e.g. Asia/Kolkata" />
          </label>
          <label class="a2-field"><span>Status</span>
            <select class="a2-input" name="status">
              {#each SOURCE_STATUSES as status}
                <option value={status} selected={(editingEpg?.status ?? 'experimental') === status}>{SOURCE_STATUS_LABELS[status]}</option>
              {/each}
            </select>
          </label>
          {#if !editingEpg}
            <label class="a2-field a2-checkbox-field"><input type="checkbox" name="enabled" /> <span>Enabled immediately</span></label>
          {/if}
          <label class="a2-field a2-field-wide"><span>Description</span>
            <input class="a2-input" type="text" name="description" value={editingEpg?.description ?? ''} maxlength="1000" />
          </label>
        </AdminFormSection>
        <div class="a2-toolbar">
          <button type="submit" class="a2-btn a2-btn-primary">{editingEpg ? 'Save EPG source' : 'Create EPG source'}</button>
          <button type="button" class="a2-btn" onclick={closeSheets}>Cancel</button>
        </div>
      </form>
    </AdminSheet>

    <!-- ==================== Endpoint add sheet (admin-authored sources) ==================== -->
    <AdminSheet open={createEndpointEntryId !== null} title="Add endpoint" onClose={closeSheets}>
      <form method="POST" action="?/addEndpoint" use:enhance onsubmit={() => setTimeout(closeSheets, 0)}>
        <input type="hidden" name="entryId" value={createEndpointEntryId ?? ''} />
        <AdminFormSection heading="Typed endpoint" description="direct_stream requires dash/hls (the DASH/HLS engine paths); embed_page must not declare a format (iframe integration).">
          <label class="a2-field"><span>Endpoint kind *</span>
            <select class="a2-input" name="endpointKind" bind:value={endpointKindDraft}>
              <option value="direct_stream">direct_stream (DASH/HLS)</option>
              <option value="embed_page">embed_page (iframe)</option>
            </select>
          </label>
          {#if endpointKindDraft === 'direct_stream'}
            <label class="a2-field"><span>Stream format *</span>
              <select class="a2-input" name="streamFormat" required>
                <option value="hls">HLS</option>
                <option value="dash">DASH</option>
              </select>
            </label>
          {/if}
          <label class="a2-field a2-field-wide"><span>URL (https) *</span>
            <input class="a2-input" type="url" name="url" maxlength="2048" required placeholder="https://cdn.example.com/stream.m3u8" />
          </label>
          <label class="a2-field"><span>Ordering (0 = first within the entry)</span>
            <input class="a2-input" type="number" name="ordering" value="0" min="0" max="100000" step="1" />
          </label>
          <label class="a2-field"><span>Label (optional)</span>
            <input class="a2-input" type="text" name="label" maxlength="120" />
          </label>
        </AdminFormSection>
        <div class="a2-toolbar">
          <button type="submit" class="a2-btn a2-btn-primary">Add endpoint</button>
          <button type="button" class="a2-btn" onclick={closeSheets}>Cancel</button>
        </div>
      </form>
    </AdminSheet>

    <!-- ==================== Confirmed delete (impact preview) ==================== -->
    <AdminConfirmDialog
      open={pendingDelete !== null}
      title="Delete {pendingDelete?.kind === 'source' ? 'source' : pendingDelete?.kind === 'channel' ? 'canonical channel' : pendingDelete?.kind === 'epg' ? 'EPG source' : 'endpoint'}?"
      description={pendingDelete?.impact ?? ''}
      confirmLabel="Delete"
      cancelLabel="Cancel"
      tone="danger"
      onconfirm={confirmDelete}
      oncancel={() => (pendingDelete = null)}
    >
      <form method="POST" action={pendingDelete?.kind === 'source' ? '?/deleteSource' : pendingDelete?.kind === 'channel' ? '?/deleteChannel' : pendingDelete?.kind === 'epg' ? '?/deleteEpgSource' : '?/deleteEndpoint'} bind:this={deleteFormEl}>
        <input type="hidden" name="id" value={pendingDelete?.id ?? ''} />
      </form>
      <p class="a2-muted">The database cascades/foreign keys remain the final safety net; the counts above were computed live at page load.</p>
    </AdminConfirmDialog>
  </AdminPage>
</AdminAppShell>

<style>
  /* Shared Admin2-consistent styles for the Live TV workspace. */
  .notice {
    padding: var(--a2-space-3) var(--a2-space-4);
    border-radius: var(--a2-radius-md);
    font-size: var(--a2-text-sm);
    border: 1px solid var(--a2-border-strong);
  }
  .notice-ok {
    background: var(--a2-green-soft);
    border-color: var(--a2-green-border);
    color: var(--a2-green);
  }
  .notice-error {
    background: var(--a2-red-soft);
    border-color: var(--a2-red-border);
    color: var(--a2-red);
  }

  .a2-grid { display: grid; gap: var(--a2-space-3); }
  .a2-cards-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .a2-stat {
    display: flex; flex-direction: column; gap: var(--a2-space-1);
    padding: var(--a2-space-4);
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
  }
  .a2-stat-value { font-size: var(--a2-text-2xl); font-weight: 700; color: var(--a2-text-bright); line-height: 1; }
  .a2-stat-label { font-size: var(--a2-text-xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--a2-text-muted); }
  .a2-stat-sub { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); }

  .a2-section { margin-bottom: var(--a2-space-6); }
  .a2-row-head { display: flex; align-items: center; justify-content: space-between; gap: var(--a2-space-3); flex-wrap: wrap; margin-bottom: var(--a2-space-2); }
  .a2-h2 { margin: 0; font-size: var(--a2-text-lg); font-weight: 600; color: var(--a2-text); }
  .a2-h3 { margin: var(--a2-space-4) 0 var(--a2-space-2); font-size: var(--a2-text-md); font-weight: 600; color: var(--a2-text); }
  .a2-muted { color: var(--a2-text-muted); font-size: var(--a2-text-sm); line-height: 1.55; margin: 0 0 var(--a2-space-2); }
  .a2-dim { color: var(--a2-text-dim); font-size: var(--a2-text-xs); }
  .a2-footnote { color: var(--a2-text-dim); font-size: var(--a2-text-xs); border-top: 1px solid var(--a2-border); padding-top: var(--a2-space-3); }

  .a2-chip-row { display: flex; flex-wrap: wrap; gap: var(--a2-space-2); margin-top: var(--a2-space-2); }
  .a2-chip {
    display: inline-flex; align-items: center;
    padding: 2px var(--a2-space-2);
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border);
    border-radius: 999px;
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-muted);
    max-width: 100%;
    overflow-wrap: anywhere;
  }

  .a2-toolbar { display: flex; align-items: center; gap: var(--a2-space-2); flex-wrap: wrap; margin: var(--a2-space-3) 0; }
  .a2-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text);
    font-size: var(--a2-text-sm);
    font-weight: 500;
    text-decoration: none;
    cursor: pointer;
    transition: background var(--a2-motion-micro) var(--a2-ease-out), border-color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .a2-btn:hover { background: var(--a2-surface-4); border-color: var(--a2-border-strong); }
  .a2-btn:focus-visible { outline: 2px solid var(--a2-cyan); outline-offset: 2px; }
  .a2-btn-primary { background: var(--a2-cyan-soft); border-color: var(--a2-cyan); color: var(--a2-cyan); }
  .a2-btn-primary:hover { background: var(--a2-cyan-soft); filter: brightness(1.08); }
  .a2-btn-sm { padding: 4px var(--a2-space-2); font-size: var(--a2-text-xs); }

  .a2-icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 30px; min-height: 30px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--a2-radius-xs);
    color: var(--a2-text-muted);
    cursor: pointer;
    text-decoration: none;
    transition: color var(--a2-motion-micro) var(--a2-ease-out), background var(--a2-motion-micro) var(--a2-ease-out);
  }
  .a2-icon-btn:hover { background: var(--a2-surface-3); color: var(--a2-text); }
  .a2-icon-btn:focus-visible { outline: 2px solid var(--a2-cyan); outline-offset: 1px; }
  .a2-icon-btn:disabled { opacity: 0.35; cursor: not-allowed; }

  .a2-actions { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; }
  .a2-actions form { display: inline-flex; }
  .a2-inline-form { display: inline-flex; align-items: center; gap: var(--a2-space-2); flex-wrap: wrap; }
  .a2-filter-row select, .a2-filter-row input { max-width: 220px; }

  .a2-table-wrap { overflow-x: auto; border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); }
  .a2-table { width: 100%; border-collapse: collapse; font-size: var(--a2-text-sm); }
  .a2-table th {
    text-align: left; padding: var(--a2-space-2) var(--a2-space-3);
    font-size: var(--a2-text-2xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--a2-text-dim);
    border-bottom: 1px solid var(--a2-border);
    background: var(--a2-surface-2);
    white-space: nowrap;
  }
  .a2-table td { padding: var(--a2-space-2) var(--a2-space-3); border-bottom: 1px solid var(--a2-border); vertical-align: middle; }
  .a2-table tbody tr:last-child td { border-bottom: none; }
  .a2-cell-title { color: var(--a2-text); font-weight: 500; }
  .a2-cell-sub { color: var(--a2-text-dim); font-size: var(--a2-text-xs); overflow-wrap: anywhere; }
  .a2-url { font-family: var(--a2-font-mono, monospace); font-size: var(--a2-text-xs); color: var(--a2-text-muted); max-width: 340px; overflow-wrap: anywhere; }

  .a2-input {
    padding: var(--a2-space-2);
    background: var(--a2-surface-2);
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text);
    font-size: var(--a2-text-sm);
  }
  .a2-input:focus-visible { outline: 2px solid var(--a2-cyan); outline-offset: 1px; }
  .a2-input-num { width: 88px; }
  .a2-input-select { max-width: 240px; }
  .a2-field { display: flex; flex-direction: column; gap: 4px; font-size: var(--a2-text-sm); color: var(--a2-text-muted); }
  .a2-checkbox-field { flex-direction: row; align-items: center; gap: var(--a2-space-2); color: var(--a2-text); }
  .a2-mapping-form { display: flex; gap: var(--a2-space-2); flex-wrap: wrap; margin-bottom: var(--a2-space-2); }
  .a2-mapping-form select { min-width: 220px; }
  .a2-mapping-form input { min-width: 240px; }
  .a2-inspector { border-top: 1px solid var(--a2-border); padding-top: var(--a2-space-4); }

  @media (max-width: 1024px) {
    .a2-cards-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 640px) {
    .a2-cards-4 { grid-template-columns: 1fr; }
    .a2-filter-row select, .a2-filter-row input { max-width: 100%; }
    .a2-url { max-width: 180px; }
    .a2-mapping-form select, .a2-mapping-form input { min-width: 0; flex: 1 1 160px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .a2-btn, .a2-icon-btn { transition: none; }
  }
</style>
