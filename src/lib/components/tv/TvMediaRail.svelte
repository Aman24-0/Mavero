<script lang="ts">
  import type { MediaItem } from '$data/content';

  let {
    title,
    eyebrow,
    items,
    railId,
    onSelect
  }: {
    title: string;
    eyebrow: string;
    items: MediaItem[];
    railId: string;
    onSelect: (item: MediaItem, event: MouseEvent, focusId: string) => void;
  } = $props();

  function focusIdFor(item: MediaItem) {
    return `tv-media-${railId}-${item.id}`;
  }
</script>

<section class="tv-media-section" aria-labelledby={`${railId}-title`}>
  <div class="section-heading">
    <div>
      <p class="eyebrow">{eyebrow}</p>
      <h2 id={`${railId}-title`}>{title}</h2>
    </div>
    <span class="direction-hint">← → browse rail · Enter select</span>
  </div>

  {#if items.length}
    <div class="tv-media-rail" role="list" aria-label={title}>
      {#each items as item, index (item.id)}
        {@const focusId = focusIdFor(item)}
        <button
          class="tv-focusable tv-media-card"
          data-tv-focusable="true"
          data-tv-focus-id={focusId}
          data-tv-focus-group={railId}
          type="button"
          onclick={(event) => onSelect(item, event, focusId)}
        >
          <div class="poster-wrap">
            <img src={item.posterSmall || item.poster} alt="" loading={index < 3 ? 'eager' : 'lazy'} />
            <span class="card-index">{String(index + 1).padStart(2, '0')}</span>
          </div>
          <span class="card-title">{item.title}</span>
          <span class="card-meta">{item.year} · ★ {item.rating.toFixed(1)}</span>
        </button>
      {/each}
    </div>
  {:else}
    <div class="tv-empty" role="status">No titles are available in this rail.</div>
  {/if}
</section>

<style>
  .tv-media-section { padding-top: 34px; }
  .section-heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 14px; }
  .eyebrow { margin: 0 0 8px; color: var(--tv-accent); font-size: .62rem; font-weight: 850; letter-spacing: .16em; text-transform: uppercase; }
  h2 { margin: 0; font-size: clamp(1.5rem, 2.6vw, 2.2rem); letter-spacing: -.05em; }
  .direction-hint { color: var(--tv-muted); font-size: .7rem; }
  .tv-media-rail { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(190px, 215px); gap: 16px; overflow-x: auto; padding: 8px 5px 18px; scrollbar-color: rgba(255,255,255,.2) transparent; }
  .tv-media-card { display: grid; min-height: 290px; align-content: start; gap: 9px; padding: 0 0 12px; overflow: hidden; border: 1px solid var(--tv-line); border-radius: 15px; color: var(--tv-ink); background: var(--tv-surface); text-align: left; cursor: pointer; }
  .poster-wrap { position: relative; aspect-ratio: 2 / 3; overflow: hidden; background: var(--tv-surface-soft); }
  .poster-wrap img { width: 100%; height: 100%; object-fit: cover; }
  .card-index { position: absolute; top: 10px; left: 10px; padding: 4px 6px; border-radius: 5px; color: #fff; background: rgba(8,10,15,.78); font-size: .58rem; font-weight: 850; letter-spacing: .1em; }
  .card-title, .card-meta { padding-inline: 13px; }
  .card-title { overflow: hidden; font-size: .92rem; font-weight: 800; text-overflow: ellipsis; white-space: nowrap; }
  .card-meta { color: var(--tv-muted); font-size: .7rem; }
  .tv-empty { min-height: 130px; display: grid; place-items: center start; padding: 22px; border: 1px dashed var(--tv-line); border-radius: 15px; color: var(--tv-muted); background: var(--tv-surface); }

  @media (max-width: 760px) {
    .section-heading { align-items: start; flex-direction: column; }
    .tv-media-rail { grid-auto-columns: minmax(170px, 64vw); }
  }
</style>
