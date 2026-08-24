<script lang="ts">
  import type { MediaItem } from '$data/content';
  import TvError from './TvError.svelte';
  import TvLoading from './TvLoading.svelte';
  import TvMediaRail from './TvMediaRail.svelte';

  let {
    items = [],
    loading = false,
    errorMessage = '',
    syncMessage = 'Local-first library',
    onRetry,
    onBrowse,
    onSelect
  }: {
    items?: MediaItem[];
    loading?: boolean;
    errorMessage?: string;
    syncMessage?: string;
    onRetry: (event: MouseEvent) => void;
    onBrowse: (event: MouseEvent) => void;
    onSelect: (item: MediaItem, event: MouseEvent, focusId: string) => void;
  } = $props();
</script>

<section class="tv-my-list" aria-labelledby="tv-my-list-title" aria-busy={loading}>
  <div class="my-list-intro">
    <div>
      <p class="eyebrow">TV library</p>
      <h2 id="tv-my-list-title">My List</h2>
      <p class="my-list-copy">Saved on this device first, with cloud sync continuing in the background when available.</p>
    </div>
    <span class="sync-status" aria-live="polite">{syncMessage}</span>
  </div>

  {#if loading}
    <TvLoading label="Loading your saved titles…" />
  {:else if errorMessage}
    <TvError message={errorMessage} onRetry={onRetry} />
  {:else if items.length}
    <TvMediaRail title="Saved titles" eyebrow="My List / all titles" railId="tv-my-list" {items} {onSelect} />
  {:else}
    <div class="my-list-empty" role="status">
      <p class="eyebrow">My List / empty</p>
      <h3>Keep a few stories close.</h3>
      <p>Open a title from Discover or Search, then add it to your TV library.</p>
      <button class="tv-focusable browse-button" data-tv-focusable="true" data-tv-focus-id="tv-my-list-browse" data-tv-focus-group="tv-my-list-empty" type="button" onclick={onBrowse}>Browse Discover</button>
    </div>
  {/if}
</section>

<style>
  .tv-my-list { padding-top: 12px; }
  .my-list-intro { display: flex; align-items: end; justify-content: space-between; gap: 24px; padding: 28px 6px 18px; border-bottom: 1px solid var(--tv-line); }
  .my-list-intro h2 { margin: 0; color: var(--tv-ink); font-size: clamp(2rem, 4vw, 3.5rem); font-weight: 900; letter-spacing: -.055em; line-height: .98; }
  .my-list-copy { max-width: 620px; margin: 13px 0 0; color: var(--tv-muted-strong, #d6dbea); font-size: clamp(.98rem, 1.3vw, 1.16rem); font-weight: 650; line-height: 1.55; }
  .sync-status { max-width: 300px; padding: 12px 14px; border: 1px solid var(--tv-line); border-radius: 10px; color: var(--tv-ink); background: rgba(255,255,255,.07); font-size: .82rem; font-weight: 800; line-height: 1.35; text-align: right; }
  .my-list-empty { display: grid; max-width: 760px; gap: 12px; margin-top: 34px; padding: 34px; border: 1px dashed var(--tv-line); border-radius: 17px; background: var(--tv-surface); }
  .my-list-empty h3 { margin: 0; color: var(--tv-ink); font-size: clamp(1.7rem, 3vw, 2.5rem); font-weight: 900; letter-spacing: -.045em; }
  .my-list-empty p:not(.eyebrow) { margin: 0; color: var(--tv-muted-strong, #d6dbea); font-size: 1rem; font-weight: 600; line-height: 1.6; }
  .browse-button { width: fit-content; min-height: 54px; padding: 13px 19px; border: 1px solid rgba(255,255,255,.24); border-radius: 11px; color: var(--tv-ink); background: rgba(255,255,255,.09); font-size: .95rem; font-weight: 850; cursor: pointer; }
  .browse-button:hover { background: rgba(255,255,255,.14); }
  @media (max-width: 760px) { .my-list-intro { align-items: start; flex-direction: column; } .sync-status { max-width: none; text-align: left; } }
</style>
