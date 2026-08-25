<script lang="ts">
  import type { MediaItem } from '$data/content';

  let {
    item,
    onSelect
  }: {
    item: MediaItem;
    onSelect: (item: MediaItem, event: MouseEvent, focusId: string) => void;
  } = $props();

  const focusId = 'tv-featured-action';
</script>

<section class="tv-hero-card" aria-labelledby="tv-featured-title">
  <img class="hero-image" src={item.backdrop || item.poster} alt="" loading="eager" decoding="async" fetchpriority="high" sizes="(max-width: 760px) 100vw, 100vw" />
  <div class="hero-scrim" aria-hidden="true"></div>
  <div class="hero-content">
    <p class="eyebrow">Featured tonight</p>
    <h2 id="tv-featured-title">{item.title}</h2>
    <p class="hero-meta">{item.year} · {item.type} · ★ {item.rating.toFixed(1)}</p>
    {#if item.description}<p class="hero-description">{item.description}</p>{/if}
    <button
      class="tv-focusable hero-action"
      data-tv-focusable="true"
      data-tv-focus-id={focusId}
      data-tv-focus-group="tv-featured"
      type="button"
      onclick={(event) => onSelect(item, event, focusId)}
    >
      View details
      <span aria-hidden="true">→</span>
    </button>
  </div>
</section>

<style>
  .tv-hero-card { position: relative; min-height: 375px; overflow: hidden; border: 1px solid var(--tv-line); border-radius: 22px; background: #101a2d; box-shadow: 0 22px 60px rgba(0, 0, 0, .24); }
  .hero-image { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center; opacity: .74; }
  .hero-scrim { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(5, 10, 20, .98) 0%, rgba(5, 10, 20, .88) 38%, rgba(5, 10, 20, .25) 100%), linear-gradient(0deg, rgba(5, 10, 20, .92), transparent 62%); }
  .hero-content { position: relative; display: grid; max-width: 720px; min-height: 375px; align-content: end; gap: 11px; padding: clamp(27px, 4.6vw, 58px); }
  .eyebrow { margin: 0; color: var(--tv-accent); font-size: .76rem; font-weight: 900; letter-spacing: .16em; text-transform: uppercase; }
  .hero-content h2 { max-width: 680px; margin: 0; color: #fff; font-size: clamp(2.4rem, 4.8vw, 4.8rem); font-weight: 950; letter-spacing: -.07em; line-height: .98; }
  .hero-meta { margin: 0; color: #fff; font-size: 1rem; font-weight: 850; text-transform: capitalize; }
  .hero-description { display: -webkit-box; max-width: 570px; margin: 0; overflow: hidden; color: #eaf4ff; font-size: clamp(1rem, 1.25vw, 1.12rem); font-weight: 700; line-height: 1.5; line-clamp: 2; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .hero-action { display: inline-flex; width: fit-content; align-items: center; gap: 18px; min-height: 58px; margin-top: 8px; padding: 15px 20px; border: 2px solid rgba(94, 220, 255, .6); border-radius: 11px; color: #04111f; background: linear-gradient(135deg, #72edff, #5d9cff); font-size: 1rem; font-weight: 950; cursor: pointer; }
  .hero-action span { color: #04111f; font-size: 1.35rem; }

  @media (max-width: 760px) {
    .tv-hero-card, .hero-content { min-height: 340px; }
    .hero-content { padding: 26px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .hero-action { transition: none; }
  }
</style>
