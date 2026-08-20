<script lang="ts">
  import { ArrowUpRight, Compass, SearchX } from 'lucide-svelte';
  export let eyebrow = 'MAVERO / Nothing here yet';
  export let title = 'A quiet corner.';
  export let message = 'Try another direction and we will keep looking.';
  export let actionLabel = 'Back to Discover';
  export let actionHref = '/discover';
  export let search = false;
</script>

<section class="empty-state" aria-live="polite">
  <div class="empty-mark" aria-hidden="true">{#if search}<SearchX size={22} />{:else}<Compass size={22} />{/if}</div>
  <div class="eyebrow">{eyebrow}</div>
  <h2>{title}</h2>
  <p>{message}</p>
  <a class="btn btn-secondary" href={actionHref}>{actionLabel} <ArrowUpRight size={15} /></a>
</section>

<style>
  .empty-state { display: grid; place-items: center; min-height: 300px; margin-top: 30px; padding: 34px 20px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); text-align: center; }
  .empty-mark { display: grid; place-items: center; width: 46px; height: 46px; margin-bottom: 16px; border: 1px solid rgba(155,135,245,.35); border-radius: 50%; color: var(--accent); }
  .empty-state h2 { margin: 8px 0 7px; font-size: 1.85rem; letter-spacing: -.06em; }
  .empty-state p { max-width: 360px; margin: 0 0 20px; color: var(--muted); font-size: .8rem; line-height: 1.65; }
</style>
