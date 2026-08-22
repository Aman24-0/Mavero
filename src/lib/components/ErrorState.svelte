<script lang="ts">
  import { AlertTriangle, RefreshCw } from 'lucide-svelte';
  export let eyebrow = 'MAVERO / Temporary interruption';
  export let title = 'The signal dropped.';
  export let message = 'We could not load this part of the catalog. Your saved experience is still safe.';
  export let retry: (() => void) | undefined = undefined;
</script>

<section class="error-state" role="alert">
  <div class="error-mark" aria-hidden="true"><AlertTriangle size={20} /></div>
  <div class="eyebrow">{eyebrow}</div>
  <h2>{title}</h2>
  <p>{message}</p>
  {#if retry}<button class="btn btn-secondary" type="button" onclick={retry}><RefreshCw size={15} /> Try again</button>{/if}
</section>

<style>
  .error-state { display: grid; place-items: center; min-height: 260px; margin-top: 28px; padding: 34px 20px; border: 1px solid rgba(224,174,114,.28); border-radius: var(--radius-lg); background: linear-gradient(135deg, rgba(224,174,114,.06), rgba(8,11,13,.12)); text-align: center; }
  .error-mark { display: grid; place-items: center; width: 48px; height: 48px; margin-bottom: 15px; border: 1px solid rgba(224,174,114,.4); border-radius: 50%; color: var(--warning); background: rgba(224,174,114,.06); }
  .error-state h2 { margin: 8px 0 7px; font-family: 'Space Grotesk', sans-serif; font-size: 1.65rem; letter-spacing: -.06em; }
  .error-state p { max-width: 390px; margin: 0 0 20px; color: var(--muted); font-size: .78rem; line-height: 1.65; }
</style>
