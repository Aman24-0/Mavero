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
  .eyebrow { margin: 0; color: var(--tv-accent); font-size: .76rem; font-weight: 900; letter-spacing: .16em; text-transform: uppercase; }
  .hero-content h2 { max-width: 720px; margin: 0; color: #fff; font-size: clamp(2.55rem, 5.4vw, 5.2rem); font-weight: 950; letter-spacing: -.07em; line-height: .98; }
  .hero-meta { margin: 0; color: #fff; font-size: 1rem; font-weight: 850; text-transform: capitalize; }
  .hero-description { max-width: 620px; margin: 0; color: #eef1f8; font-size: clamp(1rem, 1.35vw, 1.16rem); font-weight: 650; line-height: 1.55; }
  .hero-action { display: inline-flex; width: fit-content; align-items: center; gap: 22px; min-height: 58px; margin-top: 8px; padding: 15px 19px; border: 2px solid rgba(255,255,255,.28); border-radius: 11px; color: var(--tv-ink); background: rgba(255,255,255,.14); font-size: 1rem; font-weight: 900; cursor: pointer; }
  .hero-action span { color: var(--tv-accent); font-size: 1.2rem; }

  @media (max-width: 760px) {
    .tv-hero-card, .hero-content { min-height: 340px; }
    .hero-content { padding: 26px; }
  }
</style>
