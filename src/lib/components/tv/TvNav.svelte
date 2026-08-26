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

  const icons: Record<string, string> = {
    Home: '⌂',
    Search: '⌕',
    'My List': '▣',
    Settings: '⚙'
  };
</script>

<nav class="tv-nav" aria-label="TV primary navigation" data-tv-focus-group="tv-primary-nav">
  <div class="nav-heading">
    <span class="nav-mark" aria-hidden="true">M</span>
    <div>
      <p class="nav-kicker">Mavero TV</p>
      <p class="nav-caption">Remote-first viewing</p>
    </div>
  </div>

  <div class="nav-items" role="list">
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
        <span class="nav-icon" aria-hidden="true">{icons[item.label] ?? '•'}</span>
        <span class="nav-label">{item.label}</span>
        <span class="nav-index">{String(index + 1).padStart(2, '0')}</span>
      </button>
    {/each}
  </div>

  <p class="nav-hint">↑ ↓ navigate<br />Enter select</p>
</nav>

<style>
  .tv-nav { position: sticky; top: 18px; display: flex; flex-direction: column; gap: 28px; min-height: min(70dvh, 620px); padding: 22px 14px; border: 1px solid var(--tv-line); border-radius: 22px; background: linear-gradient(180deg, rgba(19, 26, 42, .98), rgba(11, 15, 26, .94)); box-shadow: 0 18px 55px rgba(0, 0, 0, .22); }
  .nav-heading { display: flex; align-items: center; gap: 12px; padding: 2px 8px 16px; border-bottom: 1px solid var(--tv-line); }
  .nav-mark { display: grid; width: 42px; height: 42px; place-items: center; border-radius: 13px; color: #06101d; background: linear-gradient(135deg, #62e8ff, #4388ff); font-size: 1.25rem; font-weight: 950; box-shadow: 0 0 24px rgba(73, 199, 255, .26); }
  .nav-kicker, .nav-caption { margin: 0; }
  .nav-kicker { color: var(--tv-ink); font-size: .96rem; font-weight: 950; letter-spacing: -.02em; }
  .nav-caption { margin-top: 3px; color: var(--tv-muted); font-size: .67rem; font-weight: 750; letter-spacing: .03em; }
  .nav-items { display: grid; gap: 10px; }
  .tv-nav-item { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; min-height: 60px; align-items: center; gap: 10px; padding: 13px 12px; border: 2px solid transparent; border-radius: 14px; color: var(--tv-muted-strong, #eef1f8); background: transparent; font-size: 1.03rem; font-weight: 900; text-align: left; cursor: pointer; transition: border-color 140ms ease, background 140ms ease, color 140ms ease, transform 140ms ease; }
  .tv-nav-item:hover { background: rgba(89, 205, 255, .08); }
  .tv-nav-item.active { border-color: rgba(79, 213, 255, .5); color: #fff; background: linear-gradient(90deg, rgba(48, 185, 255, .24), rgba(68, 108, 255, .12)); box-shadow: inset 4px 0 0 #55dfff, 0 8px 22px rgba(24, 126, 255, .12); }
  .nav-icon { color: #6ee6ff; font-size: 1.4rem; font-weight: 800; line-height: 1; }
  .nav-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nav-index { color: var(--tv-muted); font-size: .68rem; font-weight: 900; letter-spacing: .1em; }
  .nav-hint { margin: auto 8px 0; color: var(--tv-muted); font-size: .72rem; font-weight: 750; line-height: 1.65; letter-spacing: .04em; text-transform: uppercase; }

  @media (max-width: 900px) {
    .tv-nav { position: static; min-height: auto; padding: 14px; }
    .nav-heading, .nav-hint { display: none; }
    .nav-items { display: flex; gap: 9px; overflow-x: auto; scrollbar-width: none; }
    .nav-items::-webkit-scrollbar { display: none; }
    .tv-nav-item { flex: 0 0 auto; min-width: 150px; }
  }

  @media (max-width: 760px) {
    .tv-nav-item { min-width: 132px; min-height: 56px; font-size: .96rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    .tv-nav-item { transition: none; }
  }
</style>
