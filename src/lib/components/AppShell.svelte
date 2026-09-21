<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { Bookmark, CalendarClock, Compass, Search, UserRound, Clapperboard, PanelLeftClose, PanelLeft } from 'lucide-svelte';
  import { haptic } from '$lib/client/haptics';

  let { children, currentPath = '/', showMobileNav = true }: { children: Snippet; currentPath?: string; showMobileNav?: boolean } = $props();
  let shell: HTMLElement;

  const primaryLinks = [
    { label: 'Discover', href: '/discover', key: '/discover', icon: Compass },
    { label: 'Upcoming', href: '/upcoming', key: '/upcoming', icon: CalendarClock },
    { label: 'Search', href: '/search', key: '/search', icon: Search },
    { label: 'My List', href: '/my-list', key: '/my-list', icon: Bookmark },
    { label: 'Account', href: '/account', key: '/account', icon: UserRound }
  ];

  const isActive = (key: string) => currentPath === key || currentPath.startsWith(`${key}/`);

  // Sidebar collapse — persisted in localStorage
  let sidebarCollapsed = $state(false);
  const STORAGE_KEY = 'mavero:sidebar-collapsed';

  onMount(async () => {
    // Restore sidebar state
    try {
      sidebarCollapsed = localStorage.getItem(STORAGE_KEY) === 'true';
    } catch { /* SSR / no access */ }

    const { gsap } = await import('gsap');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || !shell) return;
    gsap.fromTo(shell, { opacity: 0 }, { opacity: 1, duration: 0.4, ease: 'power2.out' });
  });

  function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
    try { localStorage.setItem(STORAGE_KEY, String(sidebarCollapsed)); } catch { /* no access */ }
  }

  // Update CSS variable for sidebar width
  $effect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.style.setProperty(
        '--sidebar-current',
        sidebarCollapsed ? 'var(--sidebar-collapsed)' : 'var(--sidebar-expanded)'
      );
    }
  });
</script>

<svelte:head>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" />
</svelte:head>

<div class="page-shell" class:no-mobile-nav={!showMobileNav} bind:this={shell}>
  <!-- Desktop sidebar (fixed, 1025px+) -->
  <aside class="app-sidebar" aria-label="Primary navigation">
    <a class="brand-lockup" href="/discover" aria-label="MAVERO home">
      <span class="brand-symbol"><Clapperboard size={17} strokeWidth={2.1} /></span>
      {#if !sidebarCollapsed}<span class="brand-word">MAVERO</span>{/if}
    </a>
    <button class="sidebar-toggle" type="button" onclick={toggleSidebar} aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
      {#if sidebarCollapsed}<PanelLeft size={16} />{:else}<PanelLeftClose size={16} />{/if}
    </button>
    <nav class="sidebar-nav">
      {#each primaryLinks as link}
        {@const Icon = link.icon}
        <a class:active={isActive(link.key)} class="sidebar-link" href={link.href} aria-current={isActive(link.key) ? 'page' : undefined} title={sidebarCollapsed ? link.label : undefined}>
          <span class="sidebar-icon"><Icon size={19} strokeWidth={isActive(link.key) ? 2.3 : 1.8} /></span>
          {#if !sidebarCollapsed}<span class="sidebar-label">{link.label}</span>{/if}
        </a>
      {/each}
    </nav>
    <div class="sidebar-bottom">
      <div class="sidebar-rule"></div>
      {#if !sidebarCollapsed}<span class="sidebar-caption">Your screen. Your story.</span>{/if}
    </div>
  </aside>

  <!-- Main content area (the ONLY vertical scroll surface on desktop) -->
  <div class="app-main">
    <!-- Mobile topbar (below 1025px) -->
    <header class="topbar">
      <a class="mobile-brand" href="/discover" aria-label="MAVERO home">
        <span class="brand-symbol"><Clapperboard size={15} strokeWidth={2.2} /></span>
        <span class="brand-word">MAVERO</span>
      </a>
    </header>

    <main>{@render children()}</main>
  </div>

  <!-- Mobile bottom nav -->
  {#if showMobileNav}
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
  {/if}
</div>

<style>
  .page-shell {
    display: block;
  }

  /* ---- Desktop sidebar (fixed) ---- */
  .app-sidebar {
    display: flex;
    flex-direction: column;
    padding: 20px 12px 16px;
  }
  .brand-lockup {
    display: inline-flex; align-items: center; gap: 9px;
    padding: 0 6px 4px; color: var(--color-text); text-decoration: none;
  }
  .brand-symbol {
    display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px;
    color: var(--color-primary);
    background: var(--color-primary-soft);
    border: 1px solid var(--color-primary-border);
    box-shadow: var(--glow-primary);
  }
  .brand-word {
    font-size: .92rem; font-weight: 900; letter-spacing: .04em;
    color: var(--color-text);
  }
  .sidebar-toggle {
    display: grid; place-items: center;
    width: 28px; height: 28px; margin: 8px 0 0 6px;
    border: 1px solid transparent; border-radius: 6px;
    color: var(--color-text-muted); background: transparent; cursor: pointer;
    transition: color var(--motion-fast), background var(--motion-fast), border-color var(--motion-fast);
  }
  .sidebar-toggle:hover {
    color: var(--color-primary); background: var(--color-primary-soft);
    border-color: var(--color-border);
  }
  .sidebar-nav { display: grid; gap: 2px; margin-top: 28px; }
  .sidebar-link {
    display: flex; align-items: center; gap: 13px; min-height: 44px; padding: 0 12px;
    border: 1px solid transparent; border-radius: 10px;
    color: var(--color-text-muted); font-size: .82rem; font-weight: 600;
    text-decoration: none;
    transition: color var(--motion-fast), background var(--motion-fast), border-color var(--motion-fast), transform var(--motion-fast);
  }
  .sidebar-link:hover {
    color: var(--color-primary); background: var(--color-primary-soft);
    transform: translateX(2px);
  }
  .sidebar-link.active {
    color: var(--color-primary); font-weight: 700;
    border-color: var(--color-primary-border);
    background: var(--color-primary-soft);
    box-shadow: var(--glow-primary);
  }
  .sidebar-link.active :global(svg) { color: var(--color-primary); }
  .sidebar-link:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .sidebar-bottom { display: grid; gap: 14px; margin-top: auto; }
  .sidebar-rule { height: 1px; background: var(--color-border); }
  .sidebar-caption {
    padding: 0 12px; max-width: 150px;
    color: var(--color-text-deep); font-size: .68rem; font-weight: 500; line-height: 1.4;
  }

  /* Collapsed sidebar — icon only */
  :global(.page-shell:has(.app-sidebar .sidebar-link:not(:has(.sidebar-label)))) .sidebar-link {
    justify-content: center; padding: 0;
  }

  /* ---- Mobile topbar ---- */
  .topbar { display: none; }
  .mobile-brand { display: none; }

  /* ---- Responsive ---- */
  /* Tablet and mobile: hide sidebar, show topbar */
  @media (max-width: 1024px) {
    .app-sidebar { display: none; }
    .app-main { margin-left: 0 !important; height: auto !important; overflow-y: visible !important; }
    .topbar {
      position: sticky; top: 0; z-index: 40;
      display: flex; align-items: center;
      height: 72px; padding: 0 20px;
      border-bottom: 1px solid var(--color-border);
      background: rgba(5, 7, 8, .88); backdrop-filter: blur(22px);
    }
    .mobile-brand { display: inline-flex; }
  }

  @media (max-width: 640px) {
    .topbar {
      position: fixed; top: 0; left: 0; right: 0;
      width: 100%; box-sizing: border-box;
      height: var(--topbar-h-safe);
      padding: env(safe-area-inset-top, 0px) 16px 0;
      border-bottom: 1px solid var(--color-border);
    }
    .app-main { padding-top: var(--shell-content-top); }
    .page-shell { padding-bottom: 0; }

    /* Floating pill bottom nav */
    .mobile-nav {
      position: fixed; left: 50%; bottom: calc(14px + env(safe-area-inset-bottom, 0px));
      transform: translateX(-50%);
      z-index: 50;
      width: min(calc(100% - 24px), 420px);
    }
    .mobile-nav-inner {
      display: grid; grid-template-columns: repeat(5, 1fr);
      align-items: center; gap: 2px; padding: 6px;
      border: 1px solid var(--color-border-strong); border-radius: 999px;
      background: rgba(8, 11, 13, .85); backdrop-filter: blur(20px);
      box-shadow: 0 12px 32px rgba(0, 0, 0, .55), 0 0 0 1px rgba(0, 255, 156, .03);
    }
    .mobile-nav a {
      display: grid; place-items: center; gap: 2px;
      min-width: 0; min-height: 44px; padding: 6px 2px;
      border-radius: 999px;
      color: var(--color-text-deep);
      font-size: .54rem; font-weight: 700; letter-spacing: .02em;
      text-decoration: none;
      transition: color 180ms ease, background 180ms ease;
    }
    .mobile-nav .nav-icon { display: grid; place-items: center; }
    .mobile-nav .nav-label { white-space: nowrap; opacity: .9; }
    .mobile-nav a:hover { color: var(--color-text-muted); }
    .mobile-nav a.active {
      color: var(--color-primary);
      background: var(--color-primary-soft);
      box-shadow: var(--glow-primary);
    }
    .mobile-nav a.active :global(svg) { color: var(--color-primary); }
  }
  @media (min-width: 641px) { .mobile-nav { display: none; } }
  @media (max-width: 640px) {
    .page-shell.no-mobile-nav { padding-bottom: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .sidebar-link, .mobile-nav a { transition: none; }
  }
</style>
