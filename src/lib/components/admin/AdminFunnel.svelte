<script lang="ts">
  /**
   * AdminFunnel — Guest → Account conversion funnel visualization.
   *
   * Renders the 5-stage funnel as horizontal bars with counts and
   * conversion percentages. Each stage narrows relative to the
   * previous. Color is NOT the only signal — counts and percentages
   * are always displayed as text.
   */
  import type { FunnelResult } from '$lib/server/analytics/overview';

  let {
    funnel,
    emptyMessage = 'No funnel data for this period.'
  }: {
    funnel: FunnelResult;
    emptyMessage?: string;
  } = $props();

  const maxCount = $derived(
    funnel.stages.length === 0
      ? 1
      : Math.max(1, ...funnel.stages.map((s) => s.count))
  );
</script>

{#if funnel.stages.length === 0}
  <div class="funnel-empty" role="status">
    <span class="funnel-empty-text">{emptyMessage}</span>
  </div>
{:else}
  <ol class="funnel-list" role="list">
    {#each funnel.stages as stage, i}
      <li class="funnel-stage" style="--bar-width: {Math.max(8, (stage.count / maxCount) * 100)}%">
        <div class="stage-head">
          <span class="stage-index" aria-hidden="true">{i + 1}</span>
          <span class="stage-label">{stage.label}</span>
          <span class="stage-count">{stage.count.toLocaleString()}</span>
        </div>
        <div class="stage-bar" role="img" aria-label={`${stage.label}: ${stage.count}`}>
          <div class="stage-bar-fill"></div>
        </div>
        <div class="stage-meta">
          {#if stage.conversionFromPrevious !== null}
            <span class="stage-conversion">
              {stage.conversionFromPrevious}% from previous
            </span>
          {:else}
            <span class="stage-conversion placeholder">Starting stage</span>
          {/if}
          {#if stage.conversionFromFirst !== null && i > 0}
            <span class="stage-overall">
              {stage.conversionFromFirst}% of new visitors
            </span>
          {/if}
        </div>
      </li>
    {/each}
  </ol>
{/if}

<style>
  .funnel-list {
    display: grid;
    gap: 14px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .funnel-stage {
    display: grid;
    gap: 6px;
  }
  .stage-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .stage-index {
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border: 1px solid var(--color-primary-border);
    border-radius: 50%;
    background: var(--color-primary-soft);
    color: var(--color-primary);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .58rem;
    font-weight: 700;
  }
  .stage-label {
    flex: 1;
    color: var(--color-text);
    font-size: .72rem;
    font-weight: 600;
    letter-spacing: .02em;
  }
  .stage-count {
    color: var(--color-text);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .82rem;
    font-weight: 800;
  }
  .stage-bar {
    height: 8px;
    border-radius: 999px;
    background: var(--color-surface-elevated);
    overflow: hidden;
  }
  .stage-bar-fill {
    height: 100%;
    width: var(--bar-width);
    border-radius: 999px;
    background: linear-gradient(90deg, var(--color-primary), var(--color-primary-hover));
    transition: width var(--motion-normal) var(--ease-out);
  }
  .stage-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .stage-conversion {
    color: var(--color-secondary);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .6rem;
    font-weight: 600;
    letter-spacing: .04em;
  }
  .stage-conversion.placeholder {
    color: var(--color-text-deep);
  }
  .stage-overall {
    color: var(--color-text-muted);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: .6rem;
    font-weight: 500;
    letter-spacing: .04em;
  }
  .funnel-empty {
    display: grid;
    place-items: center;
    min-height: 160px;
    padding: 32px 16px;
    text-align: center;
    border: 1px dashed var(--color-border-strong);
    border-radius: var(--radius-md);
    background: rgba(0, 255, 156, .012);
  }
  .funnel-empty-text {
    color: var(--color-text-muted);
    font-size: .74rem;
    line-height: 1.6;
  }
</style>
