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
  <img class="hero-image" src={item.backdrop || item.poster} alt="" loading="eager" />
  <div class="hero-scrim" aria-hidden="true"></div>
  <div class="hero-content">
    <p class="eyebrow">Featured from Discover</p>
    <h2 id="tv-featured-title">{item.title}</h2>
    <p class="hero-meta">{item.year} · {item.type} · ★ {item.rating.toFixed(1)}</p>
    <p class="hero-description">{item.description}</p>
    <button
      class="tv-focusable hero-action"
      data-tv-focusable="true"
      data-tv-focus-id={focusId}
      data-tv-focus-group="tv-featured"
      type="button"
      onclick={(event) => onSelect(item, event, focusId)}
    >
      Select title
      <span aria-hidden="true">↗</span>
    </button>
  </div>
</section>

<style>
  .tv-hero-card { position: relative; min-height: 390px; overflow: hidden; border: 1px solid var(--tv-line); border-radius: 20px; background: #151925; }
  .hero-image { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center; opacity: .78; }
  .hero-scrim { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(8,10,15,.96) 0%, rgba(8,10,15,.82) 42%, rgba(8,10,15,.2) 100%), linear-gradient(0deg, rgba(8,10,15,.85), transparent 58%); }
  .hero-content { position: relative; display: grid; max-width: 760px; min-height: 390px; align-content: end; gap: 12px; padding: clamp(28px, 5vw, 64px); }
  .eyebrow { margin: 0; color: var(--tv-accent); font-size: .62rem; font-weight: 850; letter-spacing: .16em; text-transform: uppercase; }
  .hero-content h2 { max-width: 720px; margin: 0; font-size: clamp(2.4rem, 5vw, 5rem); font-weight: 850; letter-spacing: -.07em; line-height: .98; }
  .hero-meta { margin: 0; color: #e2e6ef; font-size: .84rem; font-weight: 750; text-transform: capitalize; }
  .hero-description { max-width: 620px; margin: 0; color: #c0c7d5; font-size: .9rem; line-height: 1.55; }
  .hero-action { display: inline-flex; width: fit-content; align-items: center; gap: 22px; margin-top: 8px; padding: 15px 19px; border: 1px solid rgba(255,255,255,.22); border-radius: 11px; color: var(--tv-ink); background: rgba(255,255,255,.1); font-size: .82rem; font-weight: 850; cursor: pointer; }
  .hero-action span { color: var(--tv-accent); font-size: 1.2rem; }

  @media (max-width: 760px) {
    .tv-hero-card, .hero-content { min-height: 340px; }
    .hero-content { padding: 26px; }
  }
</style>
