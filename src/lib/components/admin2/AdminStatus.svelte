<script lang="ts">
  /**
   * Admin 2.0 — AdminStatus
   * Semantic status pill with color-coded tone.
   */
  let {
    label = '',
    tone = 'neutral' as 'neutral' | 'green' | 'amber' | 'red' | 'cyan' | 'blue'
  }: {
    label: string;
    tone?: 'neutral' | 'green' | 'amber' | 'red' | 'cyan' | 'blue';
  } = $props();

  const toneMap = {
    neutral: { bg: 'var(--a2-surface-3)', border: 'var(--a2-border-strong)', text: 'var(--a2-text-muted)', dot: 'var(--a2-text-dim)' },
    green: { bg: 'var(--a2-green-soft)', border: 'var(--a2-green-border)', text: 'var(--a2-green)', dot: 'var(--a2-green)' },
    amber: { bg: 'var(--a2-amber-soft)', border: 'var(--a2-amber-border)', text: 'var(--a2-amber)', dot: 'var(--a2-amber)' },
    red: { bg: 'var(--a2-red-soft)', border: 'var(--a2-red-border)', text: 'var(--a2-red)', dot: 'var(--a2-red)' },
    cyan: { bg: 'var(--a2-cyan-soft)', border: 'var(--a2-cyan-border)', text: 'var(--a2-cyan)', dot: 'var(--a2-cyan)' },
    blue: { bg: 'var(--a2-blue-soft)', border: 'transparent', text: 'var(--a2-blue)', dot: 'var(--a2-blue)' },
  };
  const t = $derived(toneMap[tone]);
</script>

<span class="a2-status-pill" style="background:{t.bg}; border-color:{t.border}; color:{t.text}">
  <span class="a2-status-dot" style="background:{t.dot}"></span>
  {label}
</span>

<style>
  .a2-status-pill {
    display: inline-flex;
    align-items: center;
    gap: var(--a2-space-1);
    padding: 2px var(--a2-space-2);
    border: 1px solid;
    border-radius: var(--a2-radius-xs);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-2xs);
    font-weight: 600;
    letter-spacing: 0.03em;
    white-space: nowrap;
    line-height: 1.5;
  }
  .a2-status-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    flex-shrink: 0;
  }
</style>
