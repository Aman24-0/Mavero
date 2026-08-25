<script lang="ts">
  import type { MediaItem } from '$data/content';

  let {
    title,
    eyebrow,
    items,
    railId,
    onSelect,
    showProgress = false
  }: {
    title: string;
    eyebrow: string;
    items: MediaItem[];
    railId: string;
    onSelect: (item: MediaItem, event: MouseEvent, focusId: string) => void;
    showProgress?: boolean;
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
            <img src={item.posterSmall || item.poster} alt="" loading={index < 3 ? 'eager' : 'lazy'} decoding="async" sizes="(max-width: 760px) 64vw, 215px" />
            <span class="card-index">{String(index + 1).padStart(2, '0')}</span>
          </div>
          <span class="card-copy">
            <span class="card-title">{item.title}</span>
            <span class="card-meta">{item.year} · ★ {item.rating.toFixed(1)}</span>
            {#if showProgress && item.progress !== undefined}
              <span class="progress-label">{item.progressLabel ?? 'Continue watching'}</span>
              <span class="progress-track" aria-label={`${item.progressLabel ?? 'Continue watching'} progress`}><span style={`width: ${Math.max(0, Math.min(100, item.progress))}%`}></span></span>
            {/if}
          </span>
        </button>
      {/each}
    </div>
  {:else}
    <div class="tv-empty" role="status">No titles are available in this rail.</div>
  {/if}
</section>

<style>
  .tv-media-section { padding-top: 34px; content-visibility: auto; contain-intrinsic-size: auto 380px; }
  .section-heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 14px; }
  .eyebrow { margin: 0 0 8px; color: var(--tv-accent); font-size: .76rem; font-weight: 900; letter-spacing: .16em; text-transform: uppercase; }
  h2 { margin: 0; color: var(--tv-ink); font-size: clamp(1.65rem, 2.5vw, 2.35rem); font-weight: 950; letter-spacing: -.05em; }
  .direction-hint { color: var(--tv-muted-strong, #eef1f8); font-size: .82rem; font-weight: 750; }
  .tv-media-rail { display: flex; flex-wrap: nowrap; gap: 18px; overflow-x: auto; overscroll-behavior-inline: contain; padding: 8px 7px 18px 5px; scrollbar-color: rgba(124, 208, 255, .35) transparent; }
  .tv-media-card { display: grid; flex: 0 0 clamp(178px, 17vw, 215px); min-width: 0; min-height: 296px; align-content: start; gap: 0; padding: 0 0 13px; overflow: hidden; border: 2px solid var(--tv-line); border-radius: 16px; color: var(--tv-ink); background: linear-gradient(180deg, rgba(20, 31, 52, .98), rgba(12, 18, 31, .98)); text-align: left; cursor: pointer; transition: transform 140ms ease, border-color 140ms ease, box-shadow 140ms ease; }
  .tv-media-card:hover { border-color: rgba(94, 220, 255, .65); transform: translateY(-3px); }
  .poster-wrap { position: relative; aspect-ratio: 2 / 3; overflow: hidden; background: var(--tv-surface-soft); }
  .poster-wrap::after { position: absolute; inset: auto 0 0; height: 35%; background: linear-gradient(transparent, rgba(8, 13, 24, .68)); content: ''; pointer-events: none; }
  .poster-wrap img { width: 100%; height: 100%; object-fit: cover; }
  .card-index { position: absolute; top: 10px; left: 10px; z-index: 1; padding: 5px 7px; border-radius: 5px; color: #06101d; background: #6de9ff; font-size: .68rem; font-weight: 950; letter-spacing: .1em; }
  .card-copy { display: grid; gap: 7px; min-width: 0; padding: 12px 13px 0; }
  .card-title { overflow: hidden; color: var(--tv-ink); font-size: 1rem; font-weight: 900; text-overflow: ellipsis; white-space: nowrap; }
  .card-meta { color: var(--tv-muted-strong, #eef1f8); font-size: .8rem; font-weight: 750; }
  .progress-label { overflow: hidden; color: var(--tv-accent); font-size: .75rem; font-weight: 850; text-overflow: ellipsis; white-space: nowrap; }
  .progress-track { display: block; height: 5px; overflow: hidden; border-radius: 99px; background: rgba(255, 255, 255, .16); }
  .progress-track span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #59e5ff, #548bff); }
  .tv-empty { min-height: 130px; display: grid; place-items: center start; padding: 22px; border: 1px dashed var(--tv-line); border-radius: 15px; color: var(--tv-muted-strong, #eef1f8); background: var(--tv-surface); font-size: 1rem; font-weight: 650; }

  @media (max-width: 760px) {
    .section-heading { align-items: start; flex-direction: column; }
    .tv-media-card { flex-basis: min(64vw, 220px); }
  }

  @media (prefers-reduced-motion: reduce) {
    .tv-media-card { transition: none; }
  }
</style>
