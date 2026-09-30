<script lang="ts">
  /**
   * Admin 2.0 — AdminPlaceholder
   *
   * Intentional placeholder for nav destinations whose full workspace
   * is scheduled for a later Admin 2.0 phase. The placeholder makes
   * the destination's state explicit — it doesn't pretend to be a
   * finished feature.
   *
   * Used by:
   *   - /admin/media/library       (Phase C — Media Library)
   *   - /admin/media/assets        (Phase E — Hosting Assets)
   *   - /admin/media/sync          (Phase E — Hosting Sync)
   *   - /admin/media/operations    (Phase F — Operations Jobs)
   *   - /admin/media/history       (Phase F — Operations History)
   *   - /admin/media/stale         (Phase F — Operations Attention)
   */
  import type { Snippet } from 'svelte';
  import { Hammer, ArrowRight, Cog } from 'lucide-svelte';

  let {
    phase = '',
    title = '',
    description = '',
    capabilities = [] as string[],
    relatedLinks = [] as Array<{ label: string; href: string; description?: string }>,
    children
  }: {
    phase: string;
    title: string;
    description?: string;
    capabilities?: string[];
    relatedLinks?: Array<{ label: string; href: string; description?: string }>;
    children?: Snippet;
  } = $props();
</script>

<section class="a2-placeholder">
  <div class="a2-placeholder-card">
    <div class="a2-placeholder-phase">
      <Hammer size={14} />
      <span>Phase {phase}</span>
    </div>
    <h2 class="a2-placeholder-title">{title}</h2>
    {#if description}
      <p class="a2-placeholder-desc">{description}</p>
    {/if}

    {#if capabilities.length > 0}
      <div class="a2-placeholder-cap-block">
        <div class="a2-placeholder-cap-label">Planned capabilities</div>
        <ul class="a2-placeholder-cap-list">
          {#each capabilities as cap}
            <li>{cap}</li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if relatedLinks.length > 0}
      <div class="a2-placeholder-cap-block">
        <div class="a2-placeholder-cap-label">Related, available now</div>
        <div class="a2-placeholder-related">
          {#each relatedLinks as link}
            <a class="a2-placeholder-related-link" href={link.href}>
              <div class="a2-placeholder-related-text">
                <div class="a2-placeholder-related-title">{link.label}</div>
                {#if link.description}
                  <div class="a2-placeholder-related-desc">{link.description}</div>
                {/if}
              </div>
              <ArrowRight size={14} />
            </a>
          {/each}
        </div>
      </div>
    {/if}

    {#if children}
      {@render children()}
    {/if}
  </div>
</section>

<style>
  .a2-placeholder {
    display: flex;
    justify-content: center;
    padding: var(--a2-space-8) 0;
  }

  .a2-placeholder-card {
    max-width: 640px;
    width: 100%;
    padding: var(--a2-space-8);
    background: var(--a2-surface-2);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-lg);
    box-shadow: var(--a2-shadow-sm);
  }

  .a2-placeholder-phase {
    display: inline-flex;
    align-items: center;
    gap: var(--a2-space-2);
    padding: var(--a2-space-1) var(--a2-space-3);
    border: 1px solid var(--a2-amber-border);
    border-radius: var(--a2-radius-xs);
    background: var(--a2-amber-soft);
    color: var(--a2-amber);
    font-family: var(--a2-font-mono);
    font-size: var(--a2-text-2xs);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-bottom: var(--a2-space-4);
  }

  .a2-placeholder-title {
    margin: 0 0 var(--a2-space-2);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-xl);
    font-weight: 700;
    color: var(--a2-text-bright);
    letter-spacing: -0.02em;
  }

  .a2-placeholder-desc {
    margin: 0 0 var(--a2-space-6);
    color: var(--a2-text-muted);
    font-size: var(--a2-text-sm);
    line-height: 1.6;
  }

  .a2-placeholder-cap-block {
    margin-top: var(--a2-space-5);
  }

  .a2-placeholder-cap-label {
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-2xs);
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--a2-text-dim);
    margin-bottom: var(--a2-space-2);
  }

  .a2-placeholder-cap-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--a2-space-2);
  }
  .a2-placeholder-cap-list li {
    position: relative;
    padding-left: var(--a2-space-4);
    color: var(--a2-text);
    font-size: var(--a2-text-sm);
    line-height: 1.5;
  }
  .a2-placeholder-cap-list li::before {
    content: '';
    position: absolute;
    left: 0;
    top: 9px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--a2-cyan);
  }

  .a2-placeholder-related {
    display: grid;
    gap: var(--a2-space-2);
  }
  .a2-placeholder-related-link {
    display: flex;
    align-items: center;
    gap: var(--a2-space-3);
    padding: var(--a2-space-3) var(--a2-space-4);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-surface-3);
    color: var(--a2-text);
    text-decoration: none;
    transition: border-color var(--a2-motion-micro) var(--a2-ease-out),
                background var(--a2-motion-micro) var(--a2-ease-out);
  }
  .a2-placeholder-related-link:hover {
    border-color: var(--a2-cyan-border);
    background: var(--a2-cyan-soft);
  }
  .a2-placeholder-related-text {
    flex: 1;
    min-width: 0;
  }
  .a2-placeholder-related-title {
    font-size: var(--a2-text-sm);
    font-weight: 600;
    color: var(--a2-text-bright);
  }
  .a2-placeholder-related-desc {
    font-size: var(--a2-text-2xs);
    color: var(--a2-text-dim);
    margin-top: 2px;
  }

  @media (max-width: 640px) {
    .a2-placeholder-card {
      padding: var(--a2-space-5);
    }
  }
</style>
