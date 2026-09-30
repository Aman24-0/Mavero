<script lang="ts">
  /**
   * Admin 2.0 — Phase G — Integrations workspace.
   *
   * Wraps the existing Stremio addon configuration in the Admin 2.0 shell.
   * Shows a summary of configured Stremio addons with status + link to
   * the legacy /admin/addons page for full CRUD (preview, reorder, link types).
   */

  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminStatus from '$lib/components/admin2/AdminStatus.svelte';
  import { Puzzle, ExternalLink, Check, AlertCircle } from 'lucide-svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  function statusTone(status: string): 'green' | 'amber' | 'red' | 'neutral' {
    if (status === 'active') return 'green';
    if (status === 'error') return 'red';
    if (status === 'maintenance') return 'amber';
    return 'neutral';
  }
</script>

<svelte:head>
  <title>Integrations — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell active="integrations">
  <AdminPage eyebrow="System" title="Integrations" accent="cyan">
    {#snippet description()}
      <p>Stremio addon integrations. Manage addon manifests, enable/disable, configure download link types, and reorder.</p>
    {/snippet}

    {#if data.notice}
      <div class="a2-notice" role="status"><Check size={14} /> {data.notice}</div>
    {/if}

    {#if data.addons.length === 0}
      <div class="a2-empty">
        <Puzzle size={32} />
        <h3>No integrations configured</h3>
        <p>Add a Stremio addon manifest URL to begin integrating external content sources.</p>
      </div>
    {:else}
      <div class="a2-addon-table-wrap">
        <table class="a2-addon-table">
          <thead>
            <tr>
              <th>Addon</th>
              <th>Version</th>
              <th>Status</th>
              <th>Enabled</th>
              <th>Types</th>
              <th>Last sync</th>
            </tr>
          </thead>
          <tbody>
            {#each data.addons as addon (addon.id)}
              <tr>
                <td>
                  <div class="a2-addon-cell">
                    <span class="a2-addon-name">{addon.name}</span>
                    {#if addon.description}
                      <span class="a2-addon-desc">{addon.description}</span>
                    {/if}
                  </div>
                </td>
                <td class="mono">{addon.version ?? '—'}</td>
                <td>
                  {#if addon.lastError}
                    <AdminStatus label="Error" tone="red" />
                  {:else if addon.lastSuccessAt}
                    <AdminStatus label="Active" tone="green" />
                  {:else}
                    <AdminStatus label="Pending" tone="amber" />
                  {/if}
                </td>
                <td>
                  {#if addon.enabled}
                    <AdminStatus label="Enabled" tone="green" />
                  {:else}
                    <AdminStatus label="Disabled" tone="neutral" />
                  {/if}
                </td>
                <td>
                  <div class="a2-addon-types">
                    {#each addon.supportedTypes ?? [] as type}
                      <span class="a2-addon-type-badge">{type}</span>
                    {/each}
                  </div>
                </td>
                <td class="mono">
                  {#if addon.lastSuccessAt}
                    {new Date(addon.lastSuccessAt).toLocaleDateString()}
                  {:else}
                    —
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="a2-legacy-link">
        <a href="/admin/addons" class="a2-legacy-link-btn">
          <ExternalLink size={12} /> Open Stremio addon registry (full CRUD + link types)
        </a>
      </div>
    {/if}
  </AdminPage>
</AdminAppShell>

<style>
  .a2-notice { display: inline-flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-green-soft); border: 1px solid var(--a2-green-border); border-radius: var(--a2-radius-sm); color: var(--a2-green); font-size: var(--a2-text-sm); }
  .a2-empty { display: flex; flex-direction: column; align-items: center; gap: var(--a2-space-3); padding: var(--a2-space-8); text-align: center; color: var(--a2-text-muted); }
  .a2-empty h3 { margin: 0; font-size: var(--a2-text-base); color: var(--a2-text); }
  .a2-empty p { margin: 0; font-size: var(--a2-text-sm); max-width: 420px; }
  .a2-addon-table-wrap { overflow-x: auto; background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); }
  .a2-addon-table { width: 100%; border-collapse: collapse; font-size: var(--a2-text-xs); }
  .a2-addon-table thead th { padding: var(--a2-space-2) var(--a2-space-3); text-align: left; font-size: var(--a2-text-2xs); font-weight: 700; color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid var(--a2-border-strong); background: var(--a2-surface-3); }
  .a2-addon-table tbody tr { border-bottom: 1px solid var(--a2-border); }
  .a2-addon-table tbody tr:hover { background: var(--a2-surface-3); }
  .a2-addon-table tbody td { padding: var(--a2-space-2) var(--a2-space-3); color: var(--a2-text); }
  .a2-addon-cell { display: flex; flex-direction: column; gap: 2px; }
  .a2-addon-name { font-weight: 600; color: var(--a2-text-bright); }
  .a2-addon-desc { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .a2-addon-types { display: flex; gap: 2px; flex-wrap: wrap; }
  .a2-addon-type-badge { display: inline-block; padding: 1px 4px; background: var(--a2-surface-4); border-radius: var(--a2-radius-xs); font-size: 9px; text-transform: uppercase; color: var(--a2-text-muted); }
  .a2-legacy-link { padding: var(--a2-space-3) 0; }
  .a2-legacy-link-btn { display: inline-flex; align-items: center; gap: var(--a2-space-1); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text-muted); font-size: var(--a2-text-2xs); font-weight: 600; text-decoration: none; transition: all var(--a2-motion-micro, 140ms) var(--a2-ease-out); }
  .a2-legacy-link-btn:hover { color: var(--a2-cyan); border-color: var(--a2-cyan-border); }
  .mono { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); }
</style>
