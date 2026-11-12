<script lang="ts">
  /**
   * Admin 2.0 — Phase E — AdminHostingProviders
   *
   * The Providers tab. Shows a card per hosting provider with:
   *   - Identity (name, adapter, slug, enabled state)
   *   - Health status (live from ProviderHealthService — never faked)
   *   - PROVIDER INVENTORY: Assets / Ready / Linked — Assets and Ready
   *     from the latest successful sync's provider listing (includes
   *     UNLINKED files, e.g. direct-uploaded dashboard files Abyss
   *     inventory discovery surfaces); Linked is the live media_assets
   *     association. "—" = no snapshot yet (honest unknown, never a
   *     fake zero). A failed last sync shows a red note on the card.
   *   - Asset counts (drawer: usable per the canonical ready+available
   *     predicate; processing / failed / deleted / detached are
   *     diagnostic breakdowns)
   *   - Last sync timestamp + outcome
   *   - Capabilities (verified — from adapter source, never guessed)
   *   - Quota / resources (where the provider exposes them)
   *
   * PAGE ACTION AREA (Hosting navigation consolidation): Refresh health +
   * Sync all providers sit together in the header — the old separate Sync
   * tab's primary action now lives here. On mobile they wrap naturally
   * (flex-wrap, full-width row) without horizontal overflow.
   *
   * Clicking a card opens a detail drawer with the full overview + actions:
   *   - Sync now (triggers POST /api/admin/media/sync?provider=<adapter>)
   *   - Refresh health (triggers GET /api/admin/media/health?provider=<adapter>)
   *   - Open Assets (deep-links to the Media Library filtered by this provider)
   *
   * Partial-failure contract:
   *   - If one provider's health fails, that card shows "Health unavailable"
   *     but the rest still load.
   *   - If asset counts fail, the card shows counts as "—" but still loads.
   *   - If the entire providers list fails, the tab shows an error state.
   */

  import { onMount } from 'svelte';
  import { Server, RefreshCw, Activity, HardDrive, Clock, AlertCircle, Check, X, Loader2, ExternalLink, Cpu, Database, Zap } from 'lucide-svelte';
  import AdminStatus from './AdminStatus.svelte';
  import AdminCapabilityGrid from './AdminCapabilityGrid.svelte';
  import type { HostingProviderOverview, HostingProviderHealth } from '$lib/shared/hosting-types';

  let {
    providers = [] as HostingProviderOverview[],
    providersError = null as string | null,
    onsyncprovider = (async () => {}) as (adapterId: string) => Promise<void>,
    onsyncall = (async () => {}) as () => Promise<void>,
    onopenassets = (() => {}) as (adapterId: string) => void,
  }: {
    providers?: HostingProviderOverview[];
    providersError?: string | null;
    onsyncprovider?: (adapterId: string) => Promise<void>;
    onsyncall?: () => Promise<void>;
    onopenassets?: (adapterId: string) => void;
  } = $props();

  // Live health refresh state.
  let healthRefreshing = $state(false);
  // Sync-all state (Hosting navigation consolidation: the old Sync tab's
  // "Sync all providers" action now lives here, next to Refresh health).
  let syncAllInProgress = $state(false);
  let selectedProvider = $state<HostingProviderOverview | null>(null);
  let drawerOpen = $state(false);

  // Trigger a live health check on mount (the server loader used skipHealth=true
  // for fast initial render — we refresh client-side).
  let liveHealth = $state<Record<string, HostingProviderHealth | null>>({});
  let healthError = $state<string | null>(null);

  onMount(() => {
    void refreshHealth();
  });

  async function refreshHealth() {
    healthRefreshing = true;
    healthError = null;
    try {
      const res = await fetch('/api/admin/media/health');
      const data = await res.json();
      if (data.ok && data.reports) {
        const map: Record<string, HostingProviderHealth | null> = {};
        for (const report of data.reports) {
          map[report.providerAdapterId] = {
            status: report.status,
            configured: report.configured,
            latencyMs: report.latencyMs,
            lastError: report.lastError,
            checkedAt: report.checkedAt,
            quota: report.quota,
          };
        }
        liveHealth = map;
      } else if (!data.ok) {
        healthError = data.error?.message ?? 'Health check failed.';
      }
    } catch {
      healthError = 'Network error during health check.';
    }
    healthRefreshing = false;
  }

  // ============================================================
  // Health tone mapping — never fake "healthy"
  // ============================================================
  function healthTone(h: HostingProviderHealth | null | undefined): 'green' | 'amber' | 'red' | 'cyan' | 'neutral' {
    if (!h) return 'neutral';
    switch (h.status) {
      case 'healthy': return 'green';
      case 'degraded': return 'amber';
      case 'unavailable': return 'red';
      case 'misconfigured': return 'red';
      case 'unknown': return 'neutral';
      default: return 'neutral';
    }
  }
  function healthLabel(h: HostingProviderHealth | null | undefined): string {
    if (!h) return 'Checking';
    switch (h.status) {
      case 'healthy': return 'Healthy';
      case 'degraded': return 'Degraded';
      case 'unavailable': return 'Unavailable';
      case 'misconfigured': return 'Misconfigured';
      case 'unknown': return 'Unknown';
      default: return 'Unknown';
    }
  }

  // The effective health for a provider = live health (if refreshed) else
  // the server-provided health (which is null when skipHealth=true).
  function effectiveHealth(p: HostingProviderOverview): HostingProviderHealth | null {
    return liveHealth[p.adapterId] ?? p.health;
  }

  function openDetail(p: HostingProviderOverview) {
    selectedProvider = p;
    drawerOpen = true;
  }

  function formatBytes(bytes: number | null): string {
    if (bytes == null) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function formatDate(iso: string | null): string {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return '—';
    }
  }

  async function handleSync(adapterId: string) {
    await onsyncprovider(adapterId);
    // After sync, refresh health (sync may have updated asset counts).
    void refreshHealth();
  }

  /**
   * Sync ALL providers — the exact backend action the old Sync tab used
   * (POST /api/admin/media/sync with no provider param). Owned here so the
   * busy state tracks the button; the fetch itself lives in the parent page.
   */
  async function handleSyncAll() {
    if (syncAllInProgress) return;
    syncAllInProgress = true;
    try {
      await onsyncall();
      // Sync may have updated asset counts / last-sync timestamps.
      void refreshHealth();
    } finally {
      syncAllInProgress = false;
    }
  }
</script>

<section class="a2-hosting-providers" aria-label="Providers">
  {#if providersError}
    <div class="a2-hosting-error" role="alert">
      <AlertCircle size={20} />
      <div>
        <p class="a2-hosting-error-title">Failed to load providers</p>
        <p class="a2-hosting-error-desc">{providersError}</p>
      </div>
    </div>
  {:else if providers.length === 0}
    <div class="a2-hosting-empty">
      <Server size={32} />
      <h3>No hosting providers</h3>
      <p>No Vidara or Abyss providers found in <code>streaming_providers</code>. Run the Phase 4 migration or add a provider row.</p>
    </div>
  {:else}
    <header class="a2-hosting-providers-head">
      <p class="a2-hosting-providers-desc">
        {providers.length} hosting provider{providers.length === 1 ? '' : 's'} connected.
        Health is checked live — never marked healthy without verification.
      </p>
      <div class="a2-hosting-providers-actions">
        <button type="button" class="a2-hosting-refresh" onclick={refreshHealth} disabled={healthRefreshing}>
          {#if healthRefreshing}<Loader2 size={12} style="animation: a2-spin 1s linear infinite;" />{:else}<RefreshCw size={12} />{/if}
          Refresh health
        </button>
        <button
          type="button"
          class="a2-hosting-sync-all"
          onclick={handleSyncAll}
          disabled={syncAllInProgress}
          title="Reconcile Mavero's view of provider assets with each provider's own view"
        >
          {#if syncAllInProgress}<Loader2 size={12} style="animation: a2-spin 1s linear infinite;" />{:else}<RefreshCw size={12} />{/if}
          {syncAllInProgress ? 'Syncing…' : 'Sync all providers'}
        </button>
      </div>
    </header>
    {#if healthError}
      <p class="a2-hosting-health-error" role="alert">
        <AlertCircle size={12} /> {healthError}
      </p>
    {/if}

    <ul class="a2-provider-cards" role="list">
      {#each providers as p (p.adapterId)}
        {@const h = effectiveHealth(p)}
        {@const configured = h?.configured ?? false}
        <li>
          <article class="a2-provider-card" data-adapter={p.adapterId} data-unconfigured={!configured}>
            <header class="a2-provider-card-head">
              <div class="a2-provider-card-id">
                <span class="a2-provider-card-icon" data-adapter={p.adapterId}>
                  <Server size={16} />
                </span>
                <div class="a2-provider-card-name-block">
                  <h3 class="a2-provider-card-name">{p.name}</h3>
                  <span class="a2-provider-card-adapter">{p.adapterId}</span>
                </div>
              </div>
              <div class="a2-provider-card-status">
                {#if !p.enabled || !p.sourceEnabled}
                  <AdminStatus label="Disabled" tone="red" />
                {:else if !configured}
                  <AdminStatus label="Not configured" tone="amber" />
                {:else}
                  <AdminStatus label={healthLabel(h)} tone={healthTone(h)} />
                {/if}
              </div>
            </header>

            {#if h?.lastError}
              <p class="a2-provider-card-error">
                <AlertCircle size={11} /> {h.lastError}
              </p>
            {/if}

            {#if p.lastSyncOutcome === 'failed'}
              <p class="a2-provider-card-error" role="status">
                <AlertCircle size={11} /> Last sync failed{p.lastSyncError ? ` — ${p.lastSyncError}` : ''}. Inventory may be stale — Sync again.
              </p>
            {/if}

            <dl class="a2-provider-card-meta">
              <div>
                <dt>Latency</dt>
                <dd>{h?.latencyMs != null ? `${h.latencyMs}ms` : '—'}</dd>
              </div>
              <div>
                <dt>Last sync</dt>
                <dd>{formatDate(p.lastSyncAt)}</dd>
              </div>
              <!--
                PROVIDER INVENTORY (Abyss direct-upload discovery): the
                Assets/Ready/Linked triple from the latest successful sync's
                provider listing (assets = valid provider files INCLUDING
                unlinked; ready = playable subset; linked = live media_assets
                association). "—" = never synced since the inventory
                hardening — an honest unknown, never a fake zero.
              -->
              <div>
                <dt>Assets</dt>
                <dd>{p.inventory?.assets ?? '—'}</dd>
              </div>
              <div>
                <dt>Ready</dt>
                <dd>{p.inventory?.ready ?? '—'}</dd>
              </div>
              <div>
                <dt>Linked</dt>
                <dd>{p.inventory?.linked ?? '—'}</dd>
              </div>
            </dl>

            {#if h?.quota && h.quota.availability === 'available'}
              <div class="a2-provider-card-quota">
                <span class="a2-provider-card-quota-label">Storage</span>
                <span class="a2-provider-card-quota-value">
                  {formatBytes(h.quota.storageUsed)} / {formatBytes(h.quota.storageLimit)}
                </span>
              </div>
            {/if}

            <footer class="a2-provider-card-actions">
              <button type="button" class="a2-provider-card-action" onclick={() => openDetail(p)}>
                Details
              </button>
              <button type="button" class="a2-provider-card-action" onclick={() => handleSync(p.adapterId)} disabled={!configured}>
                Sync
              </button>
              <button type="button" class="a2-provider-card-action" onclick={() => onopenassets(p.adapterId)}>
                Assets
              </button>
            </footer>
          </article>
        </li>
      {/each}
    </ul>
  {/if}

  {#if drawerOpen && selectedProvider}
    {@const h = effectiveHealth(selectedProvider)}
    {@const configured = h?.configured ?? false}
    <div class="a2-provider-drawer-overlay" onclick={() => { drawerOpen = false; }} role="presentation">
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="a2-provider-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="a2-provider-drawer-title"
        tabindex="-1"
        onclick={(e) => e.stopPropagation()}
      >
        <header class="a2-provider-drawer-head">
          <div class="a2-provider-drawer-head-left">
            <span class="a2-provider-card-icon a2-provider-drawer-icon" data-adapter={selectedProvider.adapterId}>
              <Server size={18} />
            </span>
            <div>
              <h2 id="a2-provider-drawer-title" class="a2-provider-drawer-title">{selectedProvider.name}</h2>
              <span class="a2-provider-drawer-adapter">{selectedProvider.adapterId} · {selectedProvider.slug}</span>
            </div>
          </div>
          <button type="button" class="a2-provider-drawer-close" onclick={() => { drawerOpen = false; }} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div class="a2-provider-drawer-body">
          <section class="a2-provider-drawer-section">
            <h3 class="a2-provider-drawer-section-title"><Activity size={13} /> Health</h3>
            <dl class="a2-provider-drawer-dl">
              <div><dt>Status</dt><dd><AdminStatus label={healthLabel(h)} tone={healthTone(h)} /></dd></div>
              <div><dt>Configured</dt><dd>{configured ? 'Yes' : 'No'}</dd></div>
              <div><dt>Latency</dt><dd>{h?.latencyMs != null ? `${h.latencyMs}ms` : '—'}</dd></div>
              <div><dt>Checked</dt><dd>{formatDate(h?.checkedAt ?? null)}</dd></div>
              {#if h?.lastError}
                <div class="a2-provider-drawer-full"><dt>Last error</dt><dd>{h.lastError}</dd></div>
              {/if}
            </dl>
          </section>

          {#if h?.quota && h.quota.availability === 'available'}
            <section class="a2-provider-drawer-section">
              <h3 class="a2-provider-drawer-section-title"><Database size={13} /> Resources</h3>
              <dl class="a2-provider-drawer-dl">
                <div><dt>Storage used</dt><dd>{formatBytes(h.quota.storageUsed)}</dd></div>
                <div><dt>Storage limit</dt><dd>{formatBytes(h.quota.storageLimit)}</dd></div>
                <div><dt>Max upload size</dt><dd>{formatBytes(h.quota.maxUploadSize)}</dd></div>
              </dl>
            </section>
          {:else if h?.quota && h.quota.availability === 'unknown'}
            <section class="a2-provider-drawer-section">
              <h3 class="a2-provider-drawer-section-title"><Database size={13} /> Resources</h3>
              <p class="a2-provider-drawer-note">Provider does not expose quota information.</p>
            </section>
          {/if}

          <section class="a2-provider-drawer-section">
            <h3 class="a2-provider-drawer-section-title"><Cpu size={13} /> Capabilities</h3>
            <AdminCapabilityGrid capabilities={selectedProvider.capabilities} />
          </section>

          <section class="a2-provider-drawer-section">
            <h3 class="a2-provider-drawer-section-title"><HardDrive size={13} /> Assets</h3>
            {#if selectedProvider.assetCounts}
              <dl class="a2-provider-drawer-dl a2-provider-drawer-dl-grid">
                <div><dt>Total</dt><dd>{selectedProvider.assetCounts.total}</dd></div>
                <div><dt>Ready</dt><dd>{selectedProvider.assetCounts.ready}</dd></div>
                <div><dt>Processing</dt><dd>{selectedProvider.assetCounts.processing}</dd></div>
                <div><dt>Failed</dt><dd>{selectedProvider.assetCounts.failed}</dd></div>
                <div><dt>Deleted</dt><dd>{selectedProvider.assetCounts.deleted}</dd></div>
                <div><dt>Detached</dt><dd>{selectedProvider.assetCounts.detached}</dd></div>
              </dl>
            {:else}
              <p class="a2-provider-drawer-note">Asset counts unavailable.</p>
            {/if}
          </section>

          <section class="a2-provider-drawer-section">
            <h3 class="a2-provider-drawer-section-title"><Clock size={13} /> Sync</h3>
            <dl class="a2-provider-drawer-dl">
              <div><dt>Last sync</dt><dd>{formatDate(selectedProvider.lastSyncAt)}</dd></div>
              <div><dt>Outcome</dt><dd>{selectedProvider.lastSyncOutcome ?? '—'}</dd></div>
              <div><dt>Assets</dt><dd>{selectedProvider.inventory?.assets ?? '—'}</dd></div>
              <div><dt>Ready</dt><dd>{selectedProvider.inventory?.ready ?? '—'}</dd></div>
              <div><dt>Linked</dt><dd>{selectedProvider.inventory?.linked ?? '—'}</dd></div>
            </dl>
            {#if selectedProvider.lastSyncOutcome === 'failed'}
              <p class="a2-provider-drawer-note" role="status">
                Last sync failed{selectedProvider.lastSyncError ? ` — ${selectedProvider.lastSyncError}` : ''}. Inventory may be stale — run Sync again.
              </p>
            {:else if !selectedProvider.inventory}
              <p class="a2-provider-drawer-note">No provider inventory snapshot yet — run Sync to discover files uploaded outside Mavero.</p>
            {/if}
          </section>

          <section class="a2-provider-drawer-section">
            <h3 class="a2-provider-drawer-section-title"><Zap size={13} /> Actions</h3>
            <div class="a2-provider-drawer-actions">
              <button type="button" class="a2-provider-drawer-action" onclick={() => handleSync(selectedProvider!.adapterId)} disabled={!configured}>
                <RefreshCw size={13} /> Sync now
              </button>
              <button type="button" class="a2-provider-drawer-action" onclick={refreshHealth} disabled={healthRefreshing}>
                {#if healthRefreshing}<Loader2 size={13} style="animation: a2-spin 1s linear infinite;" />{:else}<RefreshCw size={13} />{/if}
                Refresh health
              </button>
              <button type="button" class="a2-provider-drawer-action" onclick={() => { onopenassets(selectedProvider!.adapterId); drawerOpen = false; }}>
                <ExternalLink size={13} /> Open in Assets
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  {/if}
</section>

<style>
  .a2-hosting-providers { display: flex; flex-direction: column; gap: var(--a2-space-4); }

  .a2-hosting-providers-head {
    display: flex; justify-content: space-between; align-items: center; gap: var(--a2-space-3);
    flex-wrap: wrap;
  }
  .a2-hosting-providers-desc {
    margin: 0; font-size: var(--a2-text-sm); color: var(--a2-text-muted);
  }
  /* Action area: Refresh health + Sync all providers side by side. Wraps
     naturally on narrow screens (no horizontal overflow — mobile-first). */
  .a2-hosting-providers-actions {
    display: flex; align-items: center; gap: var(--a2-space-2);
    flex-wrap: wrap;
  }
  .a2-hosting-refresh {
    display: inline-flex; align-items: center; gap: var(--a2-space-1);
    padding: var(--a2-space-1) var(--a2-space-3);
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text);
    font-size: var(--a2-text-2xs); font-weight: 600;
    cursor: pointer;
    transition: all var(--a2-motion-micro, 140ms) var(--a2-ease-out);
    white-space: nowrap;
  }
  .a2-hosting-refresh:hover:not(:disabled) { background: var(--a2-surface-4); border-color: var(--a2-cyan-border); color: var(--a2-cyan); }
  .a2-hosting-refresh:disabled { opacity: 0.5; cursor: not-allowed; }
  /* Sync all providers — the consolidated sync-all action (was the old
     Sync tab's primary button). Primary affordance: cyan. */
  .a2-hosting-sync-all {
    display: inline-flex; align-items: center; justify-content: center; gap: var(--a2-space-1);
    padding: var(--a2-space-1) var(--a2-space-3);
    background: var(--a2-cyan);
    border: 1px solid var(--a2-cyan);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-surface-1);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-2xs); font-weight: 700;
    cursor: pointer;
    transition: all var(--a2-motion-micro, 140ms) var(--a2-ease-out);
    white-space: nowrap;
  }
  .a2-hosting-sync-all:hover:not(:disabled) { filter: brightness(1.1); }
  .a2-hosting-sync-all:disabled { opacity: 0.5; cursor: not-allowed; }

  @media (max-width: 640px) {
    .a2-hosting-providers-actions { width: 100%; }
    .a2-hosting-refresh, .a2-hosting-sync-all { flex: 1 1 auto; }
  }

  .a2-hosting-health-error {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    margin: 0; padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-amber-soft); border: 1px solid var(--a2-amber-border);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-amber); font-size: var(--a2-text-2xs);
  }

  .a2-hosting-error {
    display: flex; gap: var(--a2-space-3); align-items: flex-start;
    padding: var(--a2-space-4);
    background: var(--a2-red-soft);
    border: 1px solid var(--a2-red-border);
    border-radius: var(--a2-radius-md);
    color: var(--a2-red);
  }
  .a2-hosting-error-title { margin: 0 0 4px; font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-red); }
  .a2-hosting-error-desc { margin: 0; font-size: var(--a2-text-xs); color: var(--a2-text-muted); }

  .a2-hosting-empty {
    display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-3);
    padding: var(--a2-space-8);
    text-align: center;
    color: var(--a2-text-muted);
  }
  .a2-hosting-empty h3 { margin: 0; font-size: var(--a2-text-base); color: var(--a2-text); }
  .a2-hosting-empty p { margin: 0; font-size: var(--a2-text-sm); max-width: 420px; }
  .a2-hosting-empty code { font-family: var(--a2-font-mono); color: var(--a2-text); }

  .a2-provider-cards {
    list-style: none; margin: 0; padding: 0;
    display: grid; grid-template-columns: 1fr 1fr;
    gap: var(--a2-space-3);
  }
  @media (max-width: 768px) {
    .a2-provider-cards { grid-template-columns: 1fr; }
  }
  .a2-provider-cards li { margin: 0; }

  .a2-provider-card {
    display: flex; flex-direction: column; gap: var(--a2-space-3);
    padding: var(--a2-space-4);
    background: var(--a2-surface-2);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
    transition: border-color var(--a2-motion-micro, 140ms) var(--a2-ease-out);
  }
  .a2-provider-card:hover { border-color: var(--a2-cyan-border); }
  .a2-provider-card[data-unconfigured="true"] { opacity: 0.85; }

  .a2-provider-card-head {
    display: flex; justify-content: space-between; align-items: flex-start;
    gap: var(--a2-space-2);
  }
  .a2-provider-card-id { display: inline-flex; align-items: center; gap: var(--a2-space-3); }
  .a2-provider-card-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; border-radius: var(--a2-radius-sm);
    background: var(--a2-surface-4); color: var(--a2-cyan);
    flex-shrink: 0;
  }
  .a2-provider-card-icon[data-adapter="abyss"] { color: var(--a2-amber); }
  .a2-provider-card-name-block { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .a2-provider-card-name {
    margin: 0; font-family: var(--a2-font-sans);
    font-size: var(--a2-text-sm); font-weight: 700;
    color: var(--a2-text-bright);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .a2-provider-card-adapter {
    font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs);
    color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.08em;
  }

  .a2-provider-card-error {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    margin: 0; padding: var(--a2-space-1) var(--a2-space-2);
    background: var(--a2-red-soft); border: 1px solid var(--a2-red-border);
    border-radius: var(--a2-radius-xs);
    color: var(--a2-red); font-size: var(--a2-text-2xs);
  }

  .a2-provider-card-meta {
    display: grid; grid-template-columns: 1fr 1fr;
    gap: var(--a2-space-2) var(--a2-space-4);
    margin: 0;
  }
  .a2-provider-card-meta > div { display: flex; flex-direction: column; gap: 1px; }
  .a2-provider-card-meta dt {
    font-size: var(--a2-text-2xs); color: var(--a2-text-dim);
    text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700;
  }
  .a2-provider-card-meta dd {
    margin: 0; font-size: var(--a2-text-sm); color: var(--a2-text);
    font-family: var(--a2-font-mono);
  }

  .a2-provider-card-quota {
    display: flex; justify-content: space-between; align-items: center;
    padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
  }
  .a2-provider-card-quota-label {
    font-size: var(--a2-text-2xs); color: var(--a2-text-dim);
    text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700;
  }
  .a2-provider-card-quota-value {
    font-size: var(--a2-text-xs); color: var(--a2-text);
    font-family: var(--a2-font-mono);
  }

  .a2-provider-card-actions {
    display: flex; gap: var(--a2-space-1);
    padding-top: var(--a2-space-2);
    border-top: 1px solid var(--a2-border);
  }
  .a2-provider-card-action {
    flex: 1;
    padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-2xs); font-weight: 600;
    cursor: pointer;
    transition: all var(--a2-motion-micro, 140ms) var(--a2-ease-out);
  }
  .a2-provider-card-action:hover:not(:disabled) {
    background: var(--a2-cyan-soft);
    border-color: var(--a2-cyan);
    color: var(--a2-cyan);
  }
  .a2-provider-card-action:disabled { opacity: 0.4; cursor: not-allowed; }

  /* ---- Drawer ---- */
  .a2-provider-drawer-overlay {
    position: fixed; inset: 0; z-index: 80;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(2px);
    display: flex; justify-content: flex-end;
    animation: a2-fade-in var(--a2-motion-normal, 240ms) var(--a2-ease-out);
  }
  @keyframes a2-fade-in { from { opacity: 0; } to { opacity: 1; } }
  .a2-provider-drawer {
    width: 100%; max-width: 480px;
    background: var(--a2-surface-1);
    border-left: 1px solid var(--a2-border-strong);
    display: flex; flex-direction: column;
    overflow-y: auto;
    animation: a2-slide-in var(--a2-motion-normal, 240ms) var(--a2-ease-out);
  }
  @keyframes a2-slide-in { from { transform: translateX(100%); } to { transform: translateX(0); } }

  .a2-provider-drawer-head {
    padding-top: env(safe-area-inset-top, 0px);
    display: flex; justify-content: space-between; align-items: center;
    gap: var(--a2-space-3);
    padding: var(--a2-space-4);
    border-bottom: 1px solid var(--a2-border);
    position: sticky; top: 0;
    background: var(--a2-surface-1);
    z-index: 1;
  }
  .a2-provider-drawer-head-left { display: inline-flex; align-items: center; gap: var(--a2-space-3); min-width: 0; }
  .a2-provider-drawer-icon { width: 36px; height: 36px; }
  .a2-provider-drawer-title {
    margin: 0; font-family: var(--a2-font-sans);
    font-size: var(--a2-text-base); font-weight: 700;
    color: var(--a2-text-bright);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .a2-provider-drawer-adapter {
    font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs);
    color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.08em;
  }
  .a2-provider-drawer-close {
    min-width: 44px;
    min-height: 44px;
    background: transparent; border: none; cursor: pointer;
    color: var(--a2-text-muted); padding: 4px; border-radius: var(--a2-radius-xs);
    display: inline-flex; align-items: center; justify-content: center;
  }
  .a2-provider-drawer-close:hover { background: var(--a2-surface-3); color: var(--a2-text); }

  .a2-provider-drawer-body {
    padding: var(--a2-space-4);
    display: flex; flex-direction: column;
    gap: var(--a2-space-5);
  }
  .a2-provider-drawer-section { display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .a2-provider-drawer-section-title {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    margin: 0;
    font-family: var(--a2-font-sans); font-size: var(--a2-text-2xs); font-weight: 700;
    color: var(--a2-cyan);
    text-transform: uppercase; letter-spacing: 0.1em;
  }
  .a2-provider-drawer-dl {
    display: grid; grid-template-columns: 1fr 1fr;
    gap: var(--a2-space-2) var(--a2-space-4);
    margin: 0;
  }
  .a2-provider-drawer-dl-grid { grid-template-columns: 1fr 1fr 1fr; }
  .a2-provider-drawer-dl > div { display: flex; flex-direction: column; gap: 2px; }
  .a2-provider-drawer-dl > div.a2-provider-drawer-full { grid-column: 1 / -1; }
  .a2-provider-drawer-dl dt {
    font-size: var(--a2-text-2xs); color: var(--a2-text-dim);
    text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700;
  }
  .a2-provider-drawer-dl dd {
    margin: 0; font-size: var(--a2-text-sm); color: var(--a2-text);
  }
  .a2-provider-drawer-note {
    margin: 0; font-size: var(--a2-text-2xs); color: var(--a2-text-muted);
    font-style: italic;
  }

  .a2-provider-drawer-actions {
    display: flex; flex-direction: column; gap: var(--a2-space-2);
  }
  .a2-provider-drawer-action {
    display: inline-flex; align-items: center; gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-xs); font-weight: 600;
    cursor: pointer; text-align: left;
    transition: all var(--a2-motion-micro, 140ms) var(--a2-ease-out);
  }
  .a2-provider-drawer-action:hover:not(:disabled) {
    background: var(--a2-cyan-soft);
    border-color: var(--a2-cyan);
    color: var(--a2-cyan);
  }
  .a2-provider-drawer-action:disabled { opacity: 0.5; cursor: not-allowed; }

  @media (max-width: 768px) {
    .a2-provider-drawer { max-width: 100%; }
    .a2-provider-drawer-dl { grid-template-columns: 1fr; }
    .a2-provider-drawer-dl-grid { grid-template-columns: 1fr 1fr; }
  }

  @keyframes a2-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  @media (prefers-reduced-motion: reduce) {
    /* Phase 2 bugfix: previously this block applied `min-width: 44px; min-height: 44px`
       to the entire .a2-provider-card and .a2-provider-drawer elements, which would
       have catastrophically collapsed them to 44×44px. The sizing was only meant
       for the close button (which already has its own min-size rule). The
       transition/animation reset applies to all listed elements. */
    .a2-provider-card, .a2-hosting-refresh, .a2-hosting-sync-all, .a2-provider-card-action, .a2-provider-drawer,
    .a2-provider-drawer-action, .a2-provider-drawer-close {
      transition: none;
      animation: none;
    }
    .a2-provider-drawer-overlay { animation: none; }
  }
</style>
