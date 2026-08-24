<script lang="ts">
  import type { TVScreen } from '$lib/tv';

  type NavItem = { id: string; label: string; screen: TVScreen };

  let {
    items,
    activeScreen,
    onActivate
  }: {
    items: NavItem[];
    activeScreen: TVScreen;
    onActivate: (item: NavItem, event: MouseEvent) => void;
  } = $props();
</script>

<nav class="tv-nav" aria-label="TV primary navigation">
  {#each items as item, index (item.id)}
    <button
      class:active={activeScreen === item.screen}
      class="tv-focusable tv-nav-item"
      data-tv-focusable="true"
      data-tv-focus-id={item.id}
      data-tv-focus-group="tv-primary-nav"
      data-tv-action={`screen:${item.screen}`}
      type="button"
      aria-current={activeScreen === item.screen ? 'page' : undefined}
      onclick={(event) => onActivate(item, event)}
    >
      <span class="nav-index">{String(index + 1).padStart(2, '0')}</span>
      <span>{item.label}</span>
    </button>
  {/each}
</nav>

<style>
  .tv-nav { display: flex; gap: 12px; overflow-x: auto; padding: 6px 4px 16px; scrollbar-width: none; }
  .tv-nav::-webkit-scrollbar { display: none; }
  .tv-nav-item { display: flex; min-width: 150px; align-items: center; gap: 12px; padding: 15px 18px; border: 1px solid var(--tv-line); border-radius: 13px; color: var(--tv-muted); background: var(--tv-surface-soft); font-size: .86rem; font-weight: 760; text-align: left; cursor: pointer; transition: border-color 140ms ease, background 140ms ease, color 140ms ease; }
  .tv-nav-item.active { color: var(--tv-ink); border-color: rgba(255, 62, 94, .58); background: rgba(255, 62, 94, .14); }
  .nav-index { color: var(--tv-accent); font-size: .62rem; font-weight: 900; letter-spacing: .12em; }

  @media (max-width: 760px) {
    .tv-nav-item { min-width: 126px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .tv-nav-item { transition: none; }
  }
</style>
