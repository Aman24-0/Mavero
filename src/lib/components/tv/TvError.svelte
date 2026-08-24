<script lang="ts">
  let {
    message = 'This TV section could not load.',
    onRetry
  }: {
    message?: string;
    onRetry: (event: MouseEvent) => void;
  } = $props();
</script>

<div class="tv-error" role="alert" aria-live="assertive">
  <div>
    <span class="eyebrow">TV section unavailable</span>
    <strong>{message}</strong>
    <p>Use Enter on Retry to request the section again.</p>
  </div>
  <button
    class="tv-focusable retry-button"
    data-tv-focusable="true"
    data-tv-focus-id="tv-retry"
    data-tv-focus-group="tv-section-actions"
    type="button"
    onclick={onRetry}
  >
    Retry
  </button>
</div>

<style>
  .tv-error { display: flex; align-items: end; justify-content: space-between; gap: 24px; min-height: 210px; padding: 28px; border: 1px solid rgba(255, 62, 94, .35); border-radius: 17px; background: rgba(255, 62, 94, .08); }
  .eyebrow { display: block; margin: 0 0 10px; color: var(--tv-accent); font-size: .76rem; font-weight: 900; letter-spacing: .16em; text-transform: uppercase; }
  .tv-error strong { display: block; color: var(--tv-ink); font-size: 1.45rem; font-weight: 950; }
  .tv-error p { margin: 8px 0 0; color: var(--tv-muted-strong, #eef1f8); font-size: .94rem; font-weight: 650; }
  .retry-button { min-width: 146px; min-height: 56px; padding: 15px 20px; border: 2px solid var(--tv-accent); border-radius: 11px; color: #fff; background: var(--tv-accent); font-size: .98rem; font-weight: 900; cursor: pointer; }
  @media (max-width: 760px) { .tv-error { align-items: stretch; flex-direction: column; } }
</style>
