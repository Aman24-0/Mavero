<script lang="ts">
  import { ArrowUpRight, Compass, SearchX } from 'lucide-svelte';
  export let eyebrow = 'MAVERO / Nothing here yet';
  export let title = 'A quiet corner.';
  export let message = 'Try another direction and we will keep looking.';
  export let actionLabel = 'Back to Discover';
  export let actionHref = '/discover';
  export let search = false;
  // Optional in-place action. When provided, the CTA renders as a button
  // that invokes it (e.g. CollectionPage "Clear filters") instead of
  // navigating via `actionHref`. Existing href-based usages are unchanged.
  export let onAction: (() => void) | undefined = undefined;
</script>

<section class="empty-state" aria-live="polite">
  <div class="empty-orbit" aria-hidden="true"><div class="empty-mark">{#if search}<SearchX size={21} />{:else}<Compass size={21} />{/if}</div></div>
  <div class="eyebrow">{eyebrow}</div>
  <h2>{title}</h2>
  <p>{message}</p>
  {#if onAction}
    <button class="btn btn-secondary" type="button" onclick={onAction}>{actionLabel} <ArrowUpRight size={15} /></button>
  {:else}
    <a class="btn btn-secondary" href={actionHref}>{actionLabel} <ArrowUpRight size={15} /></a>
  {/if}
</section>

<style>
  .empty-state {
    display: grid; place-items: center;
    min-height: 260px; margin-top: 26px; padding: 36px 20px;
    border: 1px solid var(--line); border-radius: var(--radius-lg);
    background: rgba(255, 255, 255, .015);
    text-align: center;
  }
  .empty-orbit {
    display: grid; place-items: center;
    width: 58px; height: 58px; margin-bottom: 15px;
    border: 1px solid rgba(255, 255, 255, .12); border-radius: 50%;
    box-shadow: 0 0 0 9px rgba(255, 255, 255, .025);
  }
  .empty-mark {
    display: grid; place-items: center;
    width: 42px; height: 42px;
    border: 1px solid var(--line-strong); border-radius: 50%;
    color: var(--ink-soft); background: rgba(0, 0, 0, .6);
  }
  .empty-state h2 { margin: 8px 0 7px; color: var(--ink); font-size: 1.4rem; font-weight: 800; letter-spacing: -.02em; }
  .empty-state p { max-width: 360px; margin: 0 0 20px; color: var(--muted); font-size: .82rem; line-height: 1.6; }
</style>
