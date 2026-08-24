<script lang="ts">
  let { label = 'Loading TV section…' }: { label?: string } = $props();
</script>

<div class="tv-loading" role="status" aria-live="polite" aria-busy="true">
  <span class="loading-orb" aria-hidden="true"></span>
  <div>
    <strong>{label}</strong>
    <p>Remote focus is held on the current navigation anchor.</p>
  </div>
</div>

<style>
  .tv-loading { display: flex; align-items: center; gap: 18px; min-height: 210px; padding: 28px; border: 1px solid var(--tv-line); border-radius: 17px; background: var(--tv-surface); }
  .loading-orb { width: 22px; height: 22px; flex: 0 0 auto; border: 3px solid rgba(255,255,255,.18); border-left-color: var(--tv-accent); border-radius: 50%; }
  .tv-loading strong { font-size: 1.08rem; }
  .tv-loading p { margin: 7px 0 0; color: var(--tv-muted); font-size: .78rem; }

</style>
