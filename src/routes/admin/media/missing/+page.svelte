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
  import { AlertCircle, Upload, EyeOff, RotateCcw, CheckCircle2, Link2, HardDrive, X, Loader2 } from 'lucide-svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let savingId = $state<string | null>(null);
  let errorId = $state<string | null>(null);
  let errorMessage = $state<string>('');

  // ============================================================
  // "Link existing file" — demand → provider file picker sheet.
  //
  // The generic existing-file linking flow for Missing Media: an
  // admin connects a provider-side file (e.g. a large video uploaded
  // directly into the Abyss dashboard because Mavero's upload path has
  // size limits) to this demand WITHOUT re-uploading it through
  // Mavero. Provider-agnostic: every registered hosting provider's
  // unlinked files are offered (Vidara + Abyss + future adapters).
  //
  // Flow: pick file → POST /api/admin/media/missing/link → the server
  // ensures the canonical media_item from the demand identity and
  // calls the CANONICAL ManagementService.linkAsset (duplicate /
  // reactivate / deleted guards, adapter playback URL, demand
  // auto-resolution) — no duplicated link logic here.
  // ============================================================
  type LinkableFile = {
    providerAdapterId: string;
    providerName: string;
    sourceId: string;
    providerAssetId: string;
    title: string | null;
    filename: string | null;
    sizeBytes: number | null;
    status: string;
  };

  let linkSheetOpen = $state(false);
  let linkSheetDemand = $state<{ id: string; title: string } | null>(null);
  let linkFiles = $state<LinkableFile[]>([]);
  let linkLoading = $state(false);
  let linkError = $state<string | null>(null);
  let linkingAssetId = $state<string | null>(null);

  function formatBytes(bytes: number | null): string {
    if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  }

  async function openLinkSheet(req: Record<string, unknown>) {
    linkSheetDemand = { id: req.id as string, title: String(req.title_snapshot ?? '') };
    linkSheetOpen = true;
    linkFiles = [];
    linkError = null;
    linkingAssetId = null;
    linkLoading = true;
    try {
      // 1. Hosting providers (generic — from the canonical registry via
      //    the providers overview endpoint; gives adapterId + sourceId).
      const provRes = await fetch('/api/admin/hosting/providers?skipHealth=1');
      const provJson = await provRes.json();
      if (!provRes.ok || !provJson.ok) {
        throw new Error(provJson?.error?.message ?? `Failed to load hosting providers (HTTP ${provRes.status}).`);
      }
      const providers: Array<{ adapterId: string; name: string; sourceId: string }> =
        (provJson.providers ?? []).filter(
          (p: { adapterId?: string | null; name?: string | null; sourceId?: string | null }): p is { adapterId: string; name: string; sourceId: string } =>
            typeof p.adapterId === 'string' && p.adapterId.length > 0 && typeof p.sourceId === 'string' && p.sourceId.length > 0 && typeof p.name === 'string',
        );

      // 2. Each provider's UNLINKED files (files with no media_assets
      //    row — discovered by provider sync). Per-provider failures are
      //    collected, not fatal, so one broken provider cannot hide the
      //    other providers' files.
      const collected: LinkableFile[] = [];
      const failures: string[] = [];
      for (const p of providers) {
        try {
          const res = await fetch(`/api/admin/hosting/providers/${encodeURIComponent(p.adapterId)}/files`);
          const json = await res.json();
          if (!res.ok || !json.ok) {
            failures.push(`${p.name}: ${json?.error?.message ?? `HTTP ${res.status}`}`);
            continue;
          }
          for (const f of json.files ?? []) {
            collected.push({
              providerAdapterId: p.adapterId,
              providerName: p.name,
              sourceId: p.sourceId,
              providerAssetId: f.providerAssetId,
              title: f.title ?? null,
              filename: f.filename ?? null,
              sizeBytes: f.sizeBytes ?? null,
              status: f.status ?? 'unknown',
            });
          }
        } catch (err) {
          failures.push(`${p.name}: ${err instanceof Error ? err.message : 'network error'}`);
        }
      }
      linkFiles = collected;
      if (collected.length === 0) {
        linkError = failures.length > 0
          ? `No linkable provider files. ${failures.join(' · ')}`
          : 'No untracked provider files found. Run a provider sync (Hosting Control → Sync) to discover files uploaded outside Mavero.';
      } else if (failures.length > 0) {
        linkError = `Some providers could not be listed: ${failures.join(' · ')}`;
      }
    } catch (err) {
      linkError = err instanceof Error ? err.message : 'Failed to load provider files.';
    } finally {
      linkLoading = false;
    }
  }

  function closeLinkSheet() {
    linkSheetOpen = false;
    linkSheetDemand = null;
    linkFiles = [];
    linkError = null;
    linkingAssetId = null;
  }

  function handleLinkSheetKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeLinkSheet();
    }
  }

  async function linkFile(file: LinkableFile) {
    if (!linkSheetDemand || linkingAssetId) return;
    linkingAssetId = file.providerAssetId;
    linkError = null;
    try {
      const res = await fetch('/api/admin/media/missing/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: linkSheetDemand.id,
          providerSourceId: file.sourceId,
          providerAssetId: file.providerAssetId,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      }
      closeLinkSheet();
      // Refresh all server load functions — the demand row resolves
      // (status ready), the Media Library gains the asset, and Hosting
      // Control counts update.
      await invalidateAll();
    } catch (err) {
      linkError = err instanceof Error ? err.message : 'Failed to link file.';
    } finally {
      linkingAssetId = null;
    }
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
                <button type="button" class="a2-missing-action a2-missing-action-link" onclick={() => openLinkSheet(req)} disabled={linkLoading}>
                  <Link2 size={14} /> Link existing
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

<svelte:window onkeydown={linkSheetOpen ? handleLinkSheetKeydown : undefined} />

{#if linkSheetOpen && linkSheetDemand}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
  <div
    class="a2-link-sheet-overlay"
    onclick={() => closeLinkSheet()}
    role="presentation"
  >
    <div
      class="a2-link-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="a2-link-sheet-title"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      <header class="a2-link-sheet-head">
        <div>
          <h2 id="a2-link-sheet-title" class="a2-link-sheet-title">Link existing file</h2>
          <p class="a2-link-sheet-sub">Attach a provider file already uploaded outside Mavero to “{linkSheetDemand.title}” — no re-upload.</p>
        </div>
        <button type="button" class="a2-link-sheet-close" onclick={() => closeLinkSheet()} aria-label="Close">
          <X size={16} />
        </button>
      </header>

      <div class="a2-link-sheet-body">
        {#if linkLoading}
          <div class="a2-link-sheet-state">
            <Loader2 size={18} style="animation: a2-link-spin 1s linear infinite;" />
            <p>Loading provider files…</p>
          </div>
        {:else if linkFiles.length === 0}
          <div class="a2-link-sheet-state">
            <HardDrive size={18} />
            <p>{linkError ?? 'No untracked provider files found.'}</p>
          </div>
        {:else}
          {#if linkError}
            <p class="a2-link-sheet-partial" role="status">{linkError}</p>
          {/if}
          <ul class="a2-link-file-list">
            {#each linkFiles as file (file.providerAssetId)}
              <li class="a2-link-file">
                <div class="a2-link-file-info">
                  <span class="a2-link-file-provider" data-adapter={file.providerAdapterId}>{file.providerName}</span>
                  <span class="a2-link-file-name">{file.title ?? file.filename ?? file.providerAssetId}</span>
                  <span class="a2-link-file-meta">
                    <span class="mono">{file.providerAssetId}</span>
                    <span>·</span>
                    <span>{file.status}</span>
                    <span>·</span>
                    <span>{formatBytes(file.sizeBytes)}</span>
                  </span>
                </div>
                <button
                  type="button"
                  class="a2-link-file-action"
                  onclick={() => linkFile(file)}
                  disabled={linkingAssetId !== null}
                >
                  {#if linkingAssetId === file.providerAssetId}
                    <Loader2 size={14} style="animation: a2-link-spin 1s linear infinite;" /> Linking…
                  {:else}
                    <Link2 size={14} /> Link
                  {/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  </div>
{/if}

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
  .a2-missing-action-link { color: var(--a2-cyan); border-color: var(--a2-cyan-border); }
  .a2-missing-action-link:hover:not(:disabled) { color: var(--a2-cyan); border-color: var(--a2-cyan); background: var(--a2-surface-3); }
  .a2-missing-card-error { display: flex; align-items: center; gap: 6px; padding: var(--a2-space-2) var(--a2-space-3); margin-top: var(--a2-space-2); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-sm); color: var(--a2-red); font-size: var(--a2-text-xs); }

  /* ===== "Link existing file" sheet ===== */
  .a2-link-sheet-overlay { position: fixed; inset: 0; z-index: 60; display: flex; align-items: flex-end; justify-content: center; background: color-mix(in srgb, var(--a2-surface-1) 70%, transparent); padding: 0; }
  .a2-link-sheet { display: flex; flex-direction: column; width: 100%; max-width: 640px; max-height: 85vh; background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md) var(--a2-radius-md) 0 0; box-shadow: 0 -8px 32px rgb(0 0 0 / 0.35); }
  .a2-link-sheet-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--a2-space-3); padding: var(--a2-space-4); border-bottom: 1px solid var(--a2-border); }
  .a2-link-sheet-title { margin: 0; font-size: var(--a2-text-base); font-weight: 700; color: var(--a2-text-bright); }
  .a2-link-sheet-sub { margin: 4px 0 0; font-size: var(--a2-text-xs); color: var(--a2-text-muted); }
  .a2-link-sheet-close { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); background: var(--a2-surface-3); color: var(--a2-text-muted); cursor: pointer; flex-shrink: 0; }
  .a2-link-sheet-close:hover { color: var(--a2-text); border-color: var(--a2-cyan-border); }
  .a2-link-sheet-body { overflow-y: auto; padding: var(--a2-space-3) var(--a2-space-4) var(--a2-space-4); }
  .a2-link-sheet-state { display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-6); color: var(--a2-text-muted); font-size: var(--a2-text-xs); text-align: center; }
  .a2-link-sheet-partial { margin: 0 0 var(--a2-space-2); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-sm); color: var(--a2-red); font-size: var(--a2-text-2xs); }
  .a2-link-file-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--a2-space-2); }
  .a2-link-file { display: flex; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-3); background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); }
  .a2-link-file-info { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
  .a2-link-file-provider { align-self: flex-start; padding: 1px 6px; background: var(--a2-surface-4); border-radius: var(--a2-radius-xs); text-transform: uppercase; font-size: var(--a2-text-2xs); font-weight: 700; color: var(--a2-cyan); letter-spacing: 0.05em; }
  .a2-link-file-name { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); word-break: break-word; }
  .a2-link-file-meta { display: flex; gap: var(--a2-space-1); flex-wrap: wrap; font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }
  .a2-link-file-action { display: inline-flex; align-items: center; gap: 6px; padding: 10px 16px; min-height: 44px; border: 1px solid var(--a2-green-border); border-radius: var(--a2-radius-sm); background: var(--a2-green-soft); color: var(--a2-green); font-size: var(--a2-text-xs); font-weight: 700; cursor: pointer; flex-shrink: 0; }
  .a2-link-file-action:hover:not(:disabled) { border-color: var(--a2-green); }
  .a2-link-file-action:disabled { opacity: 0.5; cursor: not-allowed; }
  @keyframes a2-link-spin { to { transform: rotate(360deg); } }

  .mono { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); }

  @media (max-width: 640px) {
    .a2-missing-card { padding: var(--a2-space-3); }
    .a2-missing-card-head { flex-direction: column; align-items: stretch; }
    .a2-missing-card-actions { flex-direction: column-reverse; }
    .a2-missing-action { width: 100%; justify-content: center; }
    .a2-link-file { flex-direction: column; align-items: stretch; }
    .a2-link-file-action { width: 100%; justify-content: center; }
  }

  @media (prefers-reduced-motion: reduce) {
    .a2-missing-action { transition: none; }
  }
</style>
