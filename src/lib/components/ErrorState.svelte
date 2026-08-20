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
  {#if retry}<button class="btn btn-secondary" onclick={retry}><RefreshCw size={15} /> Try again</button>{/if}
</section>

<style>
  .error-state { display: grid; place-items: center; min-height: 280px; margin-top: 30px; padding: 34px 20px; border: 1px solid rgba(212,178,124,.24); border-radius: 18px; background: rgba(212,178,124,.04); text-align: center; }
  .error-mark { display: grid; place-items: center; width: 44px; height: 44px; margin-bottom: 15px; border: 1px solid rgba(212,178,124,.35); border-radius: 50%; color: #d4b27c; }
  .error-state h2 { margin: 8px 0 7px; font-size: 1.8rem; letter-spacing: -.06em; }
  .error-state p { max-width: 390px; margin: 0 0 20px; color: var(--muted); font-size: .8rem; line-height: 1.65; }
</style>
