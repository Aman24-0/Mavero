<script lang="ts">
  // AdminMetricCard — top-of-dashboard stat tile.
  //
  // Renders the metric label (eyebrow), the big numeric/short value, and an
  // optional status foot (icon + caption) so the dashboard reads as a
  // control-room panel rather than a generic CRUD overview.
  let {
    label,
    value,
    status = '',
    statusTone = 'neutral',
    icon: Icon = undefined,
    href = ''
  }: {
    label: string;
    value: string | number;
    status?: string;
    statusTone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info';
    icon?: any;
    href?: string;
  } = $props();
</script>

{#if href}
  <a class="metric-card linked" {href} aria-label={`${label}: ${value}`}>
    <div class="metric-inner">
      <div class="metric-label">{label}</div>
      <strong class="metric-value">{value}</strong>
      {#if status}
        <span class="metric-status tone-{statusTone}">
          {#if Icon}<span class="metric-icon"><Icon size={12} /></span>{/if}
          {status}
        </span>
      {/if}
    </div>
  </a>
{:else}
  <div class="metric-card">
    <div class="metric-inner">
      <div class="metric-label">{label}</div>
      <strong class="metric-value">{value}</strong>
      {#if status}
        <span class="metric-status tone-{statusTone}">
          {#if Icon}<span class="metric-icon"><Icon size={12} /></span>{/if}
          {status}
        </span>
      {/if}
    </div>
  </div>
{/if}

<style>
  .metric-card {
    display: block;
    min-height: 118px;
    padding: 16px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    text-decoration: none;
    color: inherit;
    transition: border-color var(--motion-fast) var(--ease-out),
                background var(--motion-fast) var(--ease-out),
                transform var(--motion-fast) var(--ease-out);
  }
  .metric-card.linked:hover {
    border-color: var(--color-primary-border);
    background: rgba(0, 255, 156, .03);
    transform: translateY(-2px);
  }
  .metric-card.linked:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 3px;
  }
  .metric-inner { display: grid; gap: 6px; height: 100%; }
  .metric-label {
    color: var(--color-text-muted);
    font-size: .56rem;
    font-weight: 700;
    letter-spacing: .12em;
    text-transform: uppercase;
  }
  .metric-value {
    display: block;
    margin-top: 6px;
    color: var(--color-text);
    font-size: clamp(1.8rem, 2.6vw, 2.4rem);
    font-weight: 900;
    letter-spacing: -.04em;
    line-height: 1;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }
  .metric-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 10px;
    color: var(--color-text-muted);
    font-size: .56rem;
    font-weight: 600;
    letter-spacing: .04em;
  }
  .metric-icon { display: inline-flex; }
  .tone-good { color: var(--color-primary); }
  .tone-warn { color: var(--color-warning); }
  .tone-bad { color: var(--color-danger); }
  .tone-info { color: var(--color-secondary); }
</style>
