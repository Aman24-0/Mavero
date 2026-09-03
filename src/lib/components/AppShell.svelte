<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { Bookmark, Compass, Search, UserRound, Settings2, Clapperboard } from 'lucide-svelte';
  import { haptic } from '$lib/client/haptics';

  let { children, currentPath = '/' }: { children: Snippet; currentPath?: string } = $props();
  let shell: HTMLElement;

  const primaryLinks = [
    { label: 'Discover', href: '/discover', key: '/discover', icon: Compass },
    { label: 'Search', href: '/search', key: '/search', icon: Search },
    { label: 'My List', href: '/my-list', key: '/my-list', icon: Bookmark },
    { label: 'Profile', href: '/profile', key: '/profile', icon: UserRound }
  ];

  const isActive = (key: string) => currentPath === key || currentPath.startsWith(`${key}/`);
  onMount(async () => {
    const { gsap } = await import('gsap');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || !shell) return;
    gsap.fromTo(shell, { opacity: 0 }, { opacity: 1, duration: 0.4, ease: 'power2.out' });
  });
</script>

<svelte:head>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" />
</svelte:head>

<div class="page-shell" bind:this={shell}>
  <aside class="app-rail" aria-label="Primary navigation">
    <a class="brand-lockup" href="/discover" aria-label="MAVERO home">
      <span class="brand-symbol"><Clapperboard size={17} strokeWidth={2.1} /></span>
      <span class="brand-word">MAVERO</span>
    </a>
    <nav class="rail-nav">
      {#each primaryLinks as link}
        {@const Icon = link.icon}
        <a class:active={isActive(link.key)} class="rail-link" href={link.href} aria-current={isActive(link.key) ? 'page' : undefined}>
          <Icon size={18} strokeWidth={isActive(link.key) ? 2.3 : 1.8} /><span>{link.label}</span>
        </a>
      {/each}
    </nav>
    <div class="rail-bottom">
      <a class="rail-link" href="/settings"><Settings2 size={18} strokeWidth={1.8} /><span>Settings</span></a>
      <div class="rail-rule"></div>
      <span class="rail-caption">Your screen. Your story.</span>
    </div>
  </aside>

  <div class="app-canvas">
    <header class="topbar">
      <a class="mobile-brand" href="/discover" aria-label="MAVERO home">
        <span class="brand-symbol"><Clapperboard size={15} strokeWidth={2.2} /></span>
        <span class="brand-word">MAVERO</span>
      </a>
    </header>

    <main>{@render children()}</main>
  </div>

  <!-- Mobile floating pill bottom navigation (centered, with side margins,
       sits above page content with safe-area aware offset). -->
  <nav class="mobile-nav" aria-label="Mobile navigation">
    <div class="mobile-nav-inner">
      {#each primaryLinks as link}
        {@const Icon = link.icon}
        <a
          class:active={isActive(link.key)}
          href={link.href}
          aria-current={isActive(link.key) ? 'page' : undefined}
          aria-label={link.label}
          onclick={() => { if (!isActive(link.key)) haptic('light'); }}
        >
          <span class="nav-icon"><Icon size={20} strokeWidth={isActive(link.key) ? 2.3 : 1.8} /></span>
          <span class="nav-label">{link.label}</span>
        </a>
      {/each}
    </div>
  </nav>
</div>

<style>
  .page-shell { display: grid; grid-template-columns: 216px minmax(0, 1fr); }
  .app-rail {
    position: sticky; top: 0; z-index: 45; display: flex; flex-direction: column;
    height: 100dvh; padding: 22px 14px 20px; border-right: 1px solid var(--line);
    background: rgba(8, 8, 8, .92); backdrop-filter: blur(16px);
  }
  .brand-lockup, .mobile-brand { display: inline-flex; align-items: center; gap: 9px; padding: 0 6px; color: var(--ink); text-decoration: none; }
  .brand-symbol {
    display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px;
    color: #fff; background: rgba(255,255,255,.08); box-shadow: 0 4px 12px rgba(255,255,255,.05);
  }
  .brand-word { font-size: .92rem; font-weight: 900; letter-spacing: .04em; }
  .rail-nav { display: grid; gap: 2px; margin-top: 34px; }
  .rail-link {
    display: flex; align-items: center; gap: 13px; min-height: 46px; padding: 0 12px;
    border: 1px solid transparent; border-radius: 10px; color: var(--muted); font-size: .82rem; font-weight: 600;
    text-decoration: none;
    transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out);
  }
  .rail-link:hover { color: var(--ink); background: rgba(255, 255, 255, .05); transform: translateX(2px); }
  .rail-link.active { color: var(--ink); font-weight: 700; border-color: rgba(255,255,255,.12); background: rgba(255,255,255,.06); }
  .rail-link.active :global(svg) { color: var(--ink); }
  .rail-bottom { display: grid; gap: 14px; margin-top: auto; }
  .rail-rule { height: 1px; background: var(--line); }
  .rail-caption { padding: 0 12px; max-width: 150px; color: var(--muted-deep); font-size: .68rem; font-weight: 500; line-height: 1.4; }
  .app-canvas { min-width: 0; }
  .topbar { display: none; }
  .mobile-brand { display: none; }

  /* Tablet+: sticky topbar inside the canvas (not fixed, so it doesn't
     overlap content — content flows naturally below it). */
  @media (max-width: 900px) {
    .page-shell { display: block; }
    .app-rail { display: none; }
    .topbar {
      position: sticky; top: 0; z-index: 40;
      display: flex; align-items: center;
      height: 72px; padding: 0 20px;
      border-bottom: 1px solid var(--line);
      background: rgba(0, 0, 0, .86); backdrop-filter: blur(22px);
    }
    .mobile-brand { display: inline-flex; }
  }

  /* Mobile: fixed topbar (height includes safe-area) + floating pill
     bottom nav. Main content gets shell-level top spacing via the
     --shell-content-top CSS variable (defined in app.css), so every
     shell page inherits the correct offset without per-page hacks. */
  @media (max-width: 640px) {
    .topbar {
      position: fixed; top: 0; left: 0; right: 0;
      width: 100%; box-sizing: border-box;
      height: var(--topbar-h-safe);
      padding: env(safe-area-inset-top, 0px) 16px 0;
      border-bottom: 1px solid var(--line);
    }
    .app-canvas { padding-top: var(--shell-content-top); }
    .page-shell { padding-bottom: 0; }

    /* Floating pill bottom nav */
    .mobile-nav {
      position: fixed; left: 50%; bottom: calc(14px + env(safe-area-inset-bottom, 0px));
      transform: translateX(-50%);
      z-index: 50;
      width: min(calc(100% - 24px), 420px);
    }
    .mobile-nav-inner {
      display: grid; grid-template-columns: repeat(4, 1fr);
      align-items: center; gap: 2px;
      padding: 6px;
      border: 1px solid rgba(255, 255, 255, .1);
      border-radius: 999px;
      background: rgba(10, 10, 10, .82);
      backdrop-filter: blur(20px);
      box-shadow: 0 12px 32px rgba(0, 0, 0, .55), 0 0 0 1px rgba(255, 255, 255, .02);
    }
    .mobile-nav a {
      display: grid; place-items: center; gap: 2px;
      min-height: 44px;
      padding: 6px 4px;
      border-radius: 999px;
      color: #6f7078;
      font-size: .54rem; font-weight: 700; letter-spacing: .02em;
      text-decoration: none;
      transition: color 180ms ease, background 180ms ease;
    }
    .mobile-nav .nav-icon { display: grid; place-items: center; }
    .mobile-nav .nav-label { opacity: .9; }
    .mobile-nav a:hover { color: #c7c7cc; }
    .mobile-nav a.active {
      color: #f5f5f5;
      background: rgba(255, 255, 255, .1);
    }
    .mobile-nav a.active :global(svg) { color: #f5f5f5; }
  }
  @media (min-width: 641px) { .mobile-nav { display: none; } }
  @media (prefers-reduced-motion: reduce) {
    .rail-link, .mobile-nav a { transition: none; }
  }
</style>
