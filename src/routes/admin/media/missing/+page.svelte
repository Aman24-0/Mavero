<script lang="ts">
  /**
   * Admin 2.0 — Missing Media workspace (Phase 3, 2026-10).
   *
   * MAV-FOCUSED (Phase 3): the "Link media" button now opens the SAME
   * shared AdminAddFileWizard used by Media Library — NOT the old
   * AdminLinkMediaModal (which was a provider-inventory file picker
   * that required provider API calls). The demand row's TMDB ID,
   * content type, season, episode, and episode title are passed as a
   * preselectedMediaItem so the wizard skips the TMDB search step
   * and goes directly to provider selection.
   *
   * The wizard calls /api/admin/media/manual-link (the secure endpoint
   * that resolves canonical identity server-side via CanonicalMediaService).
   * No provider inventory API calls, no upload, no Hosting Control.
   *
   * After a successful save, the page calls invalidateAll() to refresh
   * the demand list — the linked title's demand row will be auto-resolved
   * by the demand sweep in the server loader.
   */
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import AdminAddFileWizard from '$lib/components/admin2/AdminAddFileWizard.svelte';
  import type { PreselectedMediaItem } from '$lib/components/admin2/AdminAddFileWizard.svelte';
  import { invalidateAll } from '$app/navigation';
  import { AlertCircle, EyeOff, RotateCcw, CheckCircle2, Link2 } from 'lucide-svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let savingId = $state<string | null>(null);
  let errorId = $state<string | null>(null);
  let errorMessage = $state<string>('');

  // --- Shared Add File Wizard state ---
  let wizardOpen = $state(false);
  let wizardProviders = $state<Array<{ adapterId: string; name: string; sourceId: string }>>([]);
  let preselectedMediaItem = $state<PreselectedMediaItem | null>(null);

  async function openLinkModal(req: Record<string, unknown>) {
    // Resolve hosting providers for the shared wizard. This calls
    // /api/admin/hosting/providers?skipHealth=1 which returns the
    // provider registry (no provider API calls — just DB rows).
    try {
      const provRes = await fetch('/api/admin/hosting/providers?skipHealth=1');
      const provJson = await provRes.json();
      if (provJson.ok && Array.isArray(provJson.providers)) {
        wizardProviders = provJson.providers
          .filter((p: any) => p.adapterId && p.sourceId && p.name)
          .map((p: any) => ({ adapterId: p.adapterId, name: p.name, sourceId: p.sourceId }));
      }
    } catch {
      wizardProviders = [];
    }

    // Build the preselected media item from the demand row. The demand
    // row carries the TMDB ID, content type, season, episode, title
    // snapshot, and episode title snapshot. The manual-link endpoint
    // resolves these to a real media_items UUID server-side via
    // CanonicalMediaService.ensure* — the client does NOT fabricate a
    // prefixed canonical key or a fake UUID.
    const contentType = String(req.content_type ?? 'movie');
    const tmdbId = String(req.tmdb_id ?? '');
    const season = req.season != null ? Number(req.season) : null;
    const episode = req.episode != null ? Number(req.episode) : null;

    preselectedMediaItem = {
      title: String(req.title_snapshot ?? '') + (req.episode_title_snapshot ? ` — ${req.episode_title_snapshot}` : ''),
      contentType,
      tmdbId,
      season,
      episode,
      episodeTitle: req.episode_title_snapshot ? String(req.episode_title_snapshot) : null,
    };
    wizardOpen = true;
  }

  async function onWizardSaved(_mediaAssetId: string) {
    // The save succeeded — the demand sweep in the server loader will
    // auto-resolve the demand row on the next load. invalidateAll()
    // triggers a reload of all server load functions.
    preselectedMediaItem = null;
    await invalidateAll();
  }

  async function onWizardClose() {
    wizardOpen = false;
    preselectedMediaItem = null;
    // Refresh all server load functions — the demand row may have resolved.
    await invalidateAll();
  }

  async function updateStatus(id: string, status: string) {
    savingId = id;
    errorId = null;
    errorMessage = '';
    try {
      const res = await fetch('/api/admin/media/missing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status }),
      });
      if (res.ok) {
        await invalidateAll();
      } else {
        const json = await res.json().catch(() => null);
        errorMessage = json?.error?.message ?? `Failed to update status (HTTP ${res.status}).`;
        errorId = id;
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Network error while updating status.';
      errorId = id;
    } finally {
      savingId = null;
    }
  }

  function formatContent(request: Record<string, unknown>): string {
    const ct = request.content_type as string;
    const season = request.season as number | null;
    const episode = request.episode as number | null;
    if (season != null && episode != null) {
      return `${ct} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    }
    return ct;
  }

  function formatDate(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString();
  }

</script>

<svelte:head><title>Missing Media — Mavero Admin</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<AdminAppShell active="missing-media">
  <AdminPage eyebrow="Content" title="Missing Media" accent="cyan">
    {#snippet description()}
      <p>Track demand for media not yet hosted on Mavero providers. Each card shows the request, its status, and the actions you can take.</p>
    {/snippet}

    {#if data.requests.length === 0}
      <div class="a2-empty">
        <AlertCircle size={32} />
        <h3>No missing media requests</h3>
        <p>No requests with status "{data.statusFilter}".</p>
      </div>
    {:else}
      <div class="a2-missing-list">
        {#each data.requests as req (req.id)}
          <div class="a2-missing-card" data-status={req.status}>
            <div class="a2-missing-card-head">
              <div class="a2-missing-card-title-block">
                <div class="a2-missing-card-title">{req.title_snapshot}{#if req.episode_title_snapshot} — {req.episode_title_snapshot}{/if}</div>
                <div class="a2-missing-card-meta">
                  <span class="a2-missing-type">{formatContent(req)}</span>
                  <span>·</span>
                  <span class="mono">TMDB {req.tmdb_id}</span>
                  <span>·</span>
                  <span>{req.request_count} request(s)</span>
                </div>
              </div>
              <AdminStatusBadge label={req.status} tone={req.status === 'open' ? 'bad' : req.status === 'ready' ? 'good' : 'info'} />
            </div>
            <div class="a2-missing-card-dates">
              <span><strong>First:</strong> {formatDate(req.first_requested_at)}</span>
              <span><strong>Last:</strong> {formatDate(req.last_requested_at)}</span>
            </div>
            <div class="a2-missing-card-actions">
              {#if req.status !== 'ignored'}
                <button type="button" class="a2-missing-action" onclick={() => updateStatus(req.id, 'ignored')} disabled={savingId === req.id}>
                  <EyeOff size={14} /> Ignore
                </button>
              {/if}
              {#if req.status !== 'ready'}
                <button type="button" class="a2-missing-action a2-missing-action-primary" onclick={() => updateStatus(req.id, 'ready')} disabled={savingId === req.id}>
                  <CheckCircle2 size={14} /> Resolve
                </button>
              {/if}
              {#if req.status === 'ignored' || req.status === 'ready'}
                <button type="button" class="a2-missing-action" onclick={() => updateStatus(req.id, 'open')} disabled={savingId === req.id}>
                  <RotateCcw size={14} /> Reopen
                </button>
              {/if}
              {#if req.status === 'open'}
                <button type="button" class="a2-missing-action a2-missing-action-link" onclick={() => openLinkModal(req)}>
                  <Link2 size={14} /> Link media
                </button>
              {/if}
            </div>
            {#if errorId === req.id}
              <div class="a2-missing-card-error" role="alert">
                <AlertCircle size={14} /> {errorMessage}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </AdminPage>
</AdminAppShell>

<!-- Shared Add File Wizard (same component as Media Library) -->
<AdminAddFileWizard
  bind:open={wizardOpen}
  providers={wizardProviders}
  {preselectedMediaItem}
  onsaved={onWizardSaved}
  onclose={onWizardClose}
/>

<style>
  .a2-empty { display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-8); text-align: center; color: var(--a2-text-muted); }
  .a2-empty h3 { margin: 0; font-size: var(--a2-text-base); color: var(--a2-text); }
  .a2-empty p { margin: 0; font-size: var(--a2-text-sm); max-width: 420px; }

  .a2-missing-list { display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .a2-missing-card { display: flex; flex-direction: column; gap: var(--a2-space-2); padding: var(--a2-space-3) var(--a2-space-4); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); }
  .a2-missing-card[data-status="ignored"] { opacity: 0.6; }
  .a2-missing-card[data-status="ready"] { border-color: var(--a2-green-border); }

  .a2-missing-card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--a2-space-3); flex-wrap: wrap; }
  .a2-missing-card-title-block { min-width: 0; flex: 1; }
  .a2-missing-card-title { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); word-break: break-word; }
  .a2-missing-card-meta { display: flex; gap: var(--a2-space-1); font-size: var(--a2-text-2xs); color: var(--a2-text-muted); flex-wrap: wrap; margin-top: 2px; }
  .a2-missing-type { padding: 1px 4px; background: var(--a2-surface-4); border-radius: var(--a2-radius-xs); text-transform: uppercase; color: var(--a2-cyan); }

  .a2-missing-card-dates { display: flex; gap: var(--a2-space-4); font-size: var(--a2-text-2xs); color: var(--a2-text-muted); flex-wrap: wrap; }
  .a2-missing-card-dates strong { color: var(--a2-text-dim); font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }

  .a2-missing-card-actions { display: flex; gap: var(--a2-space-2); flex-wrap: wrap; padding-top: var(--a2-space-1); border-top: 1px solid var(--a2-border); }
  .a2-missing-action { display: inline-flex; align-items: center; gap: 6px; padding: 10px 14px; min-height: 44px; border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); background: var(--a2-surface-3); color: var(--a2-text-muted); font-size: var(--a2-text-xs); font-weight: 600; cursor: pointer; text-decoration: none; transition: color var(--a2-motion-micro) var(--a2-ease-out), border-color var(--a2-motion-micro) var(--a2-ease-out); }
  .a2-missing-action:hover:not(:disabled) { color: var(--a2-cyan); border-color: var(--a2-cyan-border); }
  .a2-missing-action:disabled { opacity: 0.5; cursor: not-allowed; }
  .a2-missing-action-primary { color: var(--a2-green); border-color: var(--a2-green-border); }
  .a2-missing-action-primary:hover:not(:disabled) { color: var(--a2-green); border-color: var(--a2-green-border); background: var(--a2-green-soft); }
  .a2-missing-action-link { color: var(--a2-cyan); border-color: var(--a2-cyan-border); }
  .a2-missing-action-link:hover:not(:disabled) { color: var(--a2-cyan); border-color: var(--a2-cyan); background: var(--a2-surface-3); }
  .a2-missing-card-error { display: flex; align-items: center; gap: 6px; padding: var(--a2-space-2) var(--a2-space-3); margin-top: var(--a2-space-2); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-sm); color: var(--a2-red); font-size: var(--a2-text-xs); }

  .mono { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); }

  @media (max-width: 640px) {
    .a2-missing-card { padding: var(--a2-space-3); }
    .a2-missing-card-head { flex-direction: column; align-items: stretch; }
    .a2-missing-card-actions { flex-direction: column-reverse; }
    .a2-missing-action { width: 100%; justify-content: center; }
  }

  @media (prefers-reduced-motion: reduce) {
    .a2-missing-action { transition: none; }
  }
</style>
