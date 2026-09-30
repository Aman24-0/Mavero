<script lang="ts">
  /**
   * Admin 2.0 — Phase E — AdminCapabilityGrid
   *
   * Reusable capability display. Renders a 2-column grid of capability
   * rows, each with a check/x icon + label + description.
   *
   * Capabilities come from the adapter's getCapabilities() — never
   * guessed, never hardcoded in the component. The UI uses this to
   * drive action availability (e.g. hide Move when !caps.folderManagement).
   */

  import { Check, X } from 'lucide-svelte';
  import type { ProviderCapabilities } from '$lib/server/hosting/types';
  import { CAPABILITY_ROWS } from '$lib/shared/hosting-types';

  let {
    capabilities,
    compact = false,
  }: {
    capabilities: ProviderCapabilities;
    compact?: boolean;
  } = $props();
</script>

<ul class="a2-cap-grid" class:compact>
  {#each CAPABILITY_ROWS as row}
    {@const on = Boolean(capabilities[row.key])}
    <li class="a2-cap" class:is-on={on} class:is-off={!on}>
      <span class="a2-cap-icon" aria-hidden="true">
        {#if on}<Check size={12} />{:else}<X size={12} />{/if}
      </span>
      <span class="a2-cap-text">
        <span class="a2-cap-label">{row.label}</span>
        {#if !compact}<span class="a2-cap-desc">{row.description}</span>{/if}
      </span>
    </li>
  {/each}
</ul>

<style>
  .a2-cap-grid {
    list-style: none; margin: 0; padding: 0;
    display: grid; grid-template-columns: 1fr 1fr;
    gap: var(--a2-space-1) var(--a2-space-3);
  }
  .a2-cap-grid.compact { grid-template-columns: 1fr; }

  .a2-cap {
    display: grid; grid-template-columns: 14px 1fr;
    gap: var(--a2-space-2);
    align-items: start;
    padding: 4px 0;
    border-top: 1px solid var(--a2-border);
  }
  .a2-cap:first-child { border-top: none; }

  .a2-cap-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 14px; height: 14px; border-radius: 50%;
    margin-top: 2px;
  }
  .a2-cap.is-on .a2-cap-icon { background: var(--a2-green-soft); color: var(--a2-green); }
  .a2-cap.is-off .a2-cap-icon { background: var(--a2-surface-4); color: var(--a2-text-dim); }

  .a2-cap-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .a2-cap-label { font-size: var(--a2-text-xs); font-weight: 600; color: var(--a2-text); }
  .a2-cap.is-off .a2-cap-label { color: var(--a2-text-muted); }
  .a2-cap-desc { font-size: var(--a2-text-2xs); color: var(--a2-text-dim); line-height: 1.4; }

  @media (max-width: 640px) {
    .a2-cap-grid { grid-template-columns: 1fr; }
  }
</style>
