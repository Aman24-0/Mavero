<script lang="ts">
  // AdminStatusBadge — single-tone status pill.
  //
  // Tones match the Phase B semantic palette: cyber-green good, amber warning,
  // red danger, neutral muted for unknown/pending states. Color is NEVER the
  // only signal — the label text is always rendered alongside the dot.
  let {
    label,
    tone = 'neutral',
    dot = true
  }: {
    label: string;
    tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info';
    dot?: boolean;
  } = $props();
</script>

<span class="status-badge tone-{tone}">
  {#if dot}<span class="status-dot" aria-hidden="true"></span>{/if}
  <span class="status-label">{label}</span>
</span>

<style>
  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: rgba(255, 255, 255, .02);
    color: var(--color-text-muted);
    font-size: .55rem;
    font-weight: 700;
    letter-spacing: .04em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    flex: 0 0 auto;
  }
  .tone-good {
    color: var(--color-primary);
    border-color: var(--color-primary-border);
    background: rgba(0, 255, 156, .06);
  }
  .tone-good .status-dot { box-shadow: 0 0 6px var(--color-primary); }
  .tone-warn {
    color: var(--color-warning);
    border-color: rgba(255, 194, 71, .35);
    background: rgba(255, 194, 71, .05);
  }
  .tone-bad {
    color: var(--color-danger);
    border-color: rgba(255, 77, 109, .35);
    background: rgba(255, 77, 109, .05);
  }
  .tone-info {
    color: var(--color-secondary);
    border-color: rgba(0, 217, 255, .35);
    background: rgba(0, 217, 255, .05);
  }
  .tone-neutral {
    color: var(--color-text-muted);
  }
</style>
