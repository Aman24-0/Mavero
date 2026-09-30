<script lang="ts">
  /**
   * Admin 2.0 — Phase G — Downloads workspace.
   *
   * Wraps the existing downloader configuration in the Admin 2.0 shell.
   * Shows a summary of download providers (embed/JSON types) with a
   * link to the legacy /admin/downloaders page for full CRUD.
   *
   * The downloader configuration is complex (310 lines in the legacy page)
   * with URL template editors, type-specific fields, and default management.
   * Phase G wraps it in the new shell + provides the unified entry point.
   * The legacy page is preserved for full CRUD.
   */

  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminStatus from '$lib/components/admin2/AdminStatus.svelte';
  import { Download, ExternalLink, Check } from 'lucide-svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>Downloads — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell active="downloads">
  <AdminPage eyebrow="System" title="Downloads" accent="cyan">
    {#snippet description()}
      <p>Downloader configuration for embed and JSON-based download providers. Manage URL templates, types, and default selection.</p>
    {/snippet}

    {#if data.notice}
      <div class="a2-notice" role="status"><Check size={14} /> {data.notice}</div>
    {/if}

    {#if data.providers.length === 0}
      <div class="a2-empty">
        <Download size={32} />
        <h3>No downloader configuration</h3>
        <p>Create download providers to enable embed or JSON-based downloading.</p>
      </div>
    {:else}
      <div class="a2-dl-table-wrap">
        <table class="a2-dl-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Type</th>
              <th>Enabled</th>
              <th>Default</th>
              <th>Supports</th>
            </tr>
          </thead>
          <tbody>
            {#each data.providers as provider (provider.id)}
              <tr>
                <td>
                  <div class="a2-dl-cell">
                    <span class="a2-dl-icon">{provider.icon ?? '📦'}</span>
                    <div>
                      <div class="a2-dl-name">{provider.name}</div>
                      <div class="a2-dl-slug mono">{provider.slug}</div>
                    </div>
                  </div>
                </td>
                <td><span class="a2-dl-badge" data-type={provider.type}>{provider.type}</span></td>
                <td>
                  {#if provider.enabled}
                    <AdminStatus label="Enabled" tone="green" />
                  {:else}
                    <AdminStatus label="Disabled" tone="neutral" />
                  {/if}
                </td>
                <td>{#if provider.is_default}<AdminStatus label="Default" tone="cyan" />{:else}—{/if}</td>
                <td>
                  {#if provider.supports_movie}<span class="a2-dl-support">Movie</span>{/if}
                  {#if provider.supports_tv}<span class="a2-dl-support">TV</span>{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="a2-legacy-link">
        <a href="/admin/downloaders" class="a2-legacy-link-btn">
          <ExternalLink size={12} /> Open downloader registry (full CRUD)
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
  .a2-dl-table-wrap { overflow-x: auto; background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); }
  .a2-dl-table { width: 100%; border-collapse: collapse; font-size: var(--a2-text-xs); }
  .a2-dl-table thead th { padding: var(--a2-space-2) var(--a2-space-3); text-align: left; font-size: var(--a2-text-2xs); font-weight: 700; color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid var(--a2-border-strong); background: var(--a2-surface-3); }
  .a2-dl-table tbody tr { border-bottom: 1px solid var(--a2-border); }
  .a2-dl-table tbody tr:hover { background: var(--a2-surface-3); }
  .a2-dl-table tbody td { padding: var(--a2-space-2) var(--a2-space-3); color: var(--a2-text); }
  .a2-dl-cell { display: inline-flex; align-items: center; gap: var(--a2-space-2); }
  .a2-dl-icon { font-size: 16px; }
  .a2-dl-name { font-weight: 600; color: var(--a2-text-bright); }
  .a2-dl-slug { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); }
  .a2-dl-badge { display: inline-block; padding: 1px 6px; background: var(--a2-surface-4); border-radius: var(--a2-radius-xs); font-size: var(--a2-text-2xs); text-transform: uppercase; color: var(--a2-cyan); }
  .a2-dl-badge[data-type="json"] { color: var(--a2-amber); }
  .a2-dl-support { display: inline-block; padding: 1px 4px; background: var(--a2-surface-4); border-radius: var(--a2-radius-xs); font-size: 9px; margin-right: 2px; color: var(--a2-text-muted); }
  .a2-legacy-link { padding: var(--a2-space-3) 0; }
  .a2-legacy-link-btn { display: inline-flex; align-items: center; gap: var(--a2-space-1); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text-muted); font-size: var(--a2-text-2xs); font-weight: 600; text-decoration: none; transition: all var(--a2-motion-micro, 140ms) var(--a2-ease-out); }
  .a2-legacy-link-btn:hover { color: var(--a2-cyan); border-color: var(--a2-cyan-border); }
  .mono { font-family: var(--a2-font-mono); font-size: var(--a2-text-2xs); }
</style>
