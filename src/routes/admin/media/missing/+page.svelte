<script lang="ts">
  /**
   * Admin 2.0 — Phase 2 — Missing Media workspace.
   *
   * Phase 2: migrated from legacy <table> + AdminPageHeader to Admin 2.0
   * AdminPage + responsive card list. The previous 8-column table caused
   * page-wide horizontal scroll on mobile (no overflow wrapper). The new
   * layout is a stacked card list at all breakpoints — each card holds
   * title, type badge, request count, dates, status pill, and actions.
   *
   * Mutations now use invalidateAll() instead of a full-page reload, so the
   * rest of the admin shell + sidebar state is preserved.
   */
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import { invalidateAll } from '$app/navigation';
  import { AlertCircle, Upload, EyeOff, RotateCcw, CheckCircle2 } from 'lucide-svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let savingId = $state<string | null>(null);
  let errorId = $state<string | null>(null);
  let errorMessage = $state<string>('');

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
        // Refresh only the page data — no full app reload.
        await invalidateAll();
      } else {
        // FINDING-011 fix: surface the PATCH failure to the admin.
        // Previously there was no else branch — a 500/422 produced
        // zero user feedback, making it look like the action succeeded.
        const json = await res.json().catch(() => null);
        errorMessage = json?.error?.message ?? `Failed to update status (HTTP ${res.status}).`;
        errorId = id;
      }
    } catch (err) {
      // Network error — surface it too.
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

  function uploadUrl(req: Record<string, unknown>): string {
    const params = new URLSearchParams({
      tmdbId: String(req.tmdb_id),
      contentType: String(req.content_type),
    });
    if (req.season != null) params.set('season', String(req.season));
    if (req.episode != null) params.set('episode', String(req.episode));
    return `/admin/media/upload?${params}`;
  }
</script>

<svelte:head><title>Missing Media — Mavero Admin</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<AdminAppShell active="missing-media">
  <AdminPage eyebrow="Hosting" title="Missing Media" accent="cyan">
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
                <a class="a2-missing-action a2-missing-action-upload" href={uploadUrl(req)}>
                  <Upload size={14} /> Upload
                </a>
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
  .a2-missing-action-upload { color: var(--a2-surface-1); background: var(--a2-cyan); border-color: var(--a2-cyan); }
  .a2-missing-action-upload:hover { background: var(--a2-cyan); color: var(--a2-surface-1); border-color: var(--a2-cyan); opacity: 0.9; }
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
