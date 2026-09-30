<script lang="ts">
  /** Phase 9 — Missing Media admin page. */
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
  import AdminStatusBadge from '$lib/components/admin/AdminStatusBadge.svelte';
  import type { PageData } from './$types';

  export let data: PageData;

  async function updateStatus(id: string, status: string) {
    const res = await fetch('/api/admin/media/missing', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    });
    if (res.ok) {
      window.location.reload();
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

<svelte:head><title>Missing Media — Mavero Admin</title></svelte:head>

<AdminAppShell active="missing-media">
  <AdminPageHeader eyebrow="Hosting" title="Missing Media" description="Track demand for media not yet hosted on Mavero providers" />

  <div class="admin-content" role="main">
  {#if data.requests.length === 0}
    <p class="empty">No missing media requests with status "{data.statusFilter}".</p>
  {:else}
    <table class="table">
      <thead>
        <tr>
          <th>Title</th>
          <th>Type</th>
          <th>TMDB</th>
          <th>Requests</th>
          <th>First</th>
          <th>Last</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each data.requests as req}
          <tr>
            <td>{req.title_snapshot}{#if req.episode_title_snapshot} — {req.episode_title_snapshot}{/if}</td>
            <td>{formatContent(req)}</td>
            <td>{req.tmdb_id}</td>
            <td>{req.request_count}</td>
            <td>{formatDate(req.first_requested_at)}</td>
            <td>{formatDate(req.last_requested_at)}</td>
            <td><AdminStatusBadge label={req.status} tone={req.status === 'open' ? 'bad' : req.status === 'ready' ? 'good' : 'info'} /></td>
            <td>
              {#if req.status !== 'ignored'}
                <button class="btn btn-secondary btn-sm" onclick={() => updateStatus(req.id, 'ignored')}>Ignore</button>
              {/if}
              {#if req.status !== 'ready'}
                <button class="btn btn-secondary btn-sm" onclick={() => updateStatus(req.id, 'ready')}>Resolve</button>
              {/if}
              {#if req.status === 'ignored' || req.status === 'ready'}
                <button class="btn btn-secondary btn-sm" onclick={() => updateStatus(req.id, 'open')}>Reopen</button>
              {/if}
              {#if req.status === 'open'}
                <a class="btn btn-primary btn-sm" href={uploadUrl(req)}>Upload</a>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
</AdminAppShell>
