<script lang="ts">
  export type TVRailCard = {
    id: string;
    index: string;
    title: string;
    description: string;
    action?: string;
  };

  let {
    cards,
    onSelect
  }: {
    cards: TVRailCard[];
    onSelect: (card: TVRailCard, event: MouseEvent) => void;
  } = $props();
</script>

<div class="tv-rail" role="list" aria-label="TV focus rail">
  {#each cards as card (card.id)}
    <button
      class="tv-focusable tv-card"
      data-tv-focusable="true"
      data-tv-focus-id={card.id}
      data-tv-focus-group="tv-rail"
      data-tv-action={card.action ?? 'demo-state'}
      type="button"
      onclick={(event) => onSelect(card, event)}
    >
      <span class="card-index">{card.index}</span>
      <span class="card-title">{card.title}</span>
      <span class="card-description">{card.description}</span>
      <span class="card-arrow" aria-hidden="true">↗</span>
    </button>
  {/each}
</div>

<style>
  .tv-rail { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(240px, 1fr); gap: 16px; overflow-x: auto; padding: 10px 5px 18px; scrollbar-color: rgba(255,255,255,.2) transparent; }
  .tv-card { position: relative; display: flex; min-height: 210px; flex-direction: column; align-items: flex-start; justify-content: flex-end; gap: 10px; padding: 24px; border: 1px solid var(--tv-line); border-radius: 17px; color: var(--tv-ink); background: linear-gradient(145deg, rgba(255,255,255,.1), rgba(255,255,255,.035)); text-align: left; cursor: pointer; transition: transform 140ms ease, border-color 140ms ease, background 140ms ease; }
  .tv-card:hover { transform: translateY(-2px); border-color: rgba(255,255,255,.32); }
  .card-index { color: var(--tv-accent); font-size: .64rem; font-weight: 900; letter-spacing: .12em; }
  .card-title { font-size: 1.15rem; font-weight: 800; letter-spacing: -.025em; }
  .card-description { max-width: 210px; color: var(--tv-muted); font-size: .78rem; line-height: 1.5; }
  .card-arrow { position: absolute; top: 20px; right: 20px; color: var(--tv-accent); font-size: 1.4rem; }

  @media (max-width: 760px) {
    .tv-rail { grid-auto-columns: minmax(230px, 78vw); }
  }

  @media (prefers-reduced-motion: reduce) {
    .tv-card { transition: none; }
    .tv-card:hover { transform: none; }
  }
</style>
