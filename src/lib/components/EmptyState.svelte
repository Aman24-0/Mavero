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
  <div class="empty-orbit" aria-hidden="true"><div class="empty-mark">{#if search}<SearchX size={21} />{:else}<Compass size={21} />{/if}</div></div>
  <div class="eyebrow">{eyebrow}</div>
  <h2>{title}</h2>
  <p>{message}</p>
  <a class="btn btn-secondary" href={actionHref}>{actionLabel} <ArrowUpRight size={15} /></a>
</section>

<style>
  .empty-state { display: grid; place-items: center; min-height: 270px; margin-top: 28px; padding: 34px 20px; border: 1px solid var(--line); border-radius: var(--radius-lg); background: linear-gradient(135deg, rgba(145,182,173,.05), rgba(212,168,106,.035)); text-align: center; }
  .empty-orbit { display: grid; place-items: center; width: 58px; height: 58px; margin-bottom: 15px; border: 1px solid rgba(212,168,106,.35); border-radius: 50%; box-shadow: 0 0 0 9px rgba(212,168,106,.045); }
  .empty-mark { display: grid; place-items: center; width: 42px; height: 42px; border: 1px solid var(--line-strong); border-radius: 50%; color: var(--accent-strong); background: rgba(8,11,13,.68); }
  .empty-state h2 { margin: 8px 0 7px; font-family: 'Space Grotesk', sans-serif; font-size: 1.65rem; letter-spacing: -.06em; }
  .empty-state p { max-width: 360px; margin: 0 0 20px; color: var(--muted); font-size: .78rem; line-height: 1.65; }
</style>
