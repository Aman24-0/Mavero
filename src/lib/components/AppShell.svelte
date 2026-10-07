<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { Compass, Search, UserRound, Clapperboard, Film, PanelLeftClose, PanelLeft, Sparkles, Tv, Radio } from 'lucide-svelte';
  import AccountSheet from '$components/AccountSheet.svelte';
  import { haptic } from '$lib/client/haptics';

  let { children, currentPath = '/', showMobileNav = true, user = null, isAuthenticated = false }: { children: Snippet; currentPath?: string; showMobileNav?: boolean; user?: { id: string; email?: string | null; displayName?: string | null } | null; isAuthenticated?: boolean } = $props();
  let shell: HTMLElement;

  // Navigation & Settings Redesign, Phase 1 — the six primary destinations.
  // ONE source of truth feeds BOTH the desktop sidebar and the mobile
  // bottom nav (no duplicated hardcoded nav logic anywhere). My List is
  // reachable from the Account page today and from the Account sheet in
  // Phase 3.
  //
  // Live TV IA (LiveGT V1, LT-1): Live TV takes slot #5 — Upcoming left
  // the primary nav and now lives in the Account sheet (above My List);
  // the /upcoming route itself is unchanged.
  //
  // Phase 2 — responsive compositions:
  //   MOBILE + TABLET (≤1024px): floating pill bottom nav (touch
  //   composition) + topbar with the Account control on the right.
  //   DESKTOP (≥1025px): proper vertical sidebar (Browse hierarchy,
  //   collapse behavior) + the Account control in the header right side.
  // The pill and the sidebar are intentionally DIFFERENT compositions —
  // the mobile pill is never copied onto desktop and vice versa.
  const primaryLinks = [
    { label: 'Discover', href: '/discover', key: '/discover', icon: Compass },
    { label: 'Movies', href: '/movies', key: '/movies', icon: Film },
    { label: 'TV Shows', href: '/tv-shows', key: '/tv-shows', icon: Tv },
    { label: 'Anime', href: '/anime', key: '/anime', icon: Sparkles },
    { label: 'Live TV', href: '/live-tv', key: '/live-tv', icon: Radio },
    { label: 'Search', href: '/search', key: '/search', icon: Search }
  ];

  const isActive = (key: string) => currentPath === key || currentPath.startsWith(`${key}/`);

  // Phase 3 — the compact Account sheet, opened from the header account
  // control (topbar ≤1024px, header chip ≥1025px). Contains ONLY the
  // identity block + My List + Settings per the plan; everything else
  // lives on the /settings page.
  let accountSheetOpen = $state(false);
  const isAccountSurface = $derived(isActive('/settings'));

  function openAccountSheet() {
    if (accountSheetOpen) return;
    haptic('light');
    accountSheetOpen = true;
  }

  function closeAccountSheet() {
    accountSheetOpen = false;
  }

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
      {#if !sidebarCollapsed}<div class="sidebar-section-label" aria-hidden="true">Browse</div>{/if}
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
      <button
        type="button"
        class:active={isAccountSurface}
        class="topbar-account"
        aria-haspopup="dialog"
        aria-expanded={accountSheetOpen}
        aria-label="Account"
        aria-current={isAccountSurface ? 'page' : undefined}
        onclick={openAccountSheet}
      >
        <UserRound size={20} strokeWidth={isAccountSurface ? 2.3 : 1.8} />
      </button>
    </header>

    <main>{@render children()}</main>
  </div>

  <!-- Desktop header account control (right side, 1025px+) — opens the
       compact Account sheet (Phase 3). The sidebar carries the six
       content destinations; Account lives in the header per the
       Final IA. -->
  <button
    type="button"
    class:active={isAccountSurface}
    class="header-account"
    aria-haspopup="dialog"
    aria-expanded={accountSheetOpen}
    aria-label="Account"
    aria-current={isAccountSurface ? 'page' : undefined}
    onclick={openAccountSheet}
  >
    <UserRound size={20} strokeWidth={isAccountSurface ? 2.3 : 1.8} />
  </button>

  <!-- Compact Account sheet (Phase 3 + LT-1): identity + Upcoming + My
       List + Settings -->
  <AccountSheet open={accountSheetOpen} onClose={closeAccountSheet} {user} {isAuthenticated} />

  <!-- Mobile + tablet bottom nav (touch composition, ≤1024px) -->
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
  .sidebar-nav { display: grid; gap: 2px; margin-top: 22px; }
  /* Desktop hierarchy: a quiet section label above the six destinations.
     Hidden when collapsed (icon-only rail keeps no text chrome). */
  .sidebar-section-label {
    padding: 0 12px; margin-bottom: 8px;
    color: var(--color-text-deep);
    font-size: .6rem; font-weight: 800; letter-spacing: .16em; text-transform: uppercase;
  }
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

  /* ---- Mobile topbar (≤1024px) ---- */
  .topbar { display: none; }
  .mobile-brand { display: none; }
  .topbar-account { display: none; }

  /* ---- Desktop header account control (≥1025px, header right side) ---- */
  .header-account { display: none; }

  /* ---- Mobile + tablet bottom pill (touch composition) ----
     Hidden by default (desktop); shown + positioned at ≤1024px below. */
  .mobile-nav { display: none; }

  /* ---- Responsive ---- */
  /* Tablet and mobile: hide sidebar, show topbar + bottom pill */
  @media (max-width: 1024px) {
    .app-sidebar { display: none; }
    /* Follow-up task 2 (§8) — the sticky fix, app-main side: the base
       rule carries `overflow-x: hidden`, and a hidden x-axis COERCES a
       `visible` y-axis to `auto` — app-main stayed a scroll container
       (one that never actually scrolls, since height is auto here), so
       sticky descendants (the Explorer filter surface) resolved against
       its dead scrollport and never pinned. `overflow-x: clip` clips
       identically but never coerces the sibling axis — app-main stops
       being a scroll container below 1025px and sticky resolves against
       the real (window) scroller again. Desktop keeps the base
       overflow-y: auto scroll container (the only desktop scroll
       surface). */
    .app-main { margin-left: 0 !important; height: auto !important; overflow-y: visible !important; overflow-x: clip !important; }
    .topbar {
      position: sticky; top: 0; z-index: 40;
      display: flex; align-items: center;
      height: 72px; padding: 0 20px;
      border-bottom: 1px solid var(--color-border);
      background: rgba(5, 7, 8, .88); backdrop-filter: blur(22px);
    }
    .mobile-brand { display: inline-flex; align-items: center; gap: 9px; }
    /* Account control on the topbar right side (≤1024px) — opens the
       compact Account sheet (Phase 3). */
    .topbar-account {
      display: grid; place-items: center;
      margin-left: auto;
      width: 40px; height: 40px;
      border: 1px solid var(--color-border);
      border-radius: 12px;
      color: var(--color-text-muted);
      background: rgba(8, 11, 13, .5);
      cursor: pointer;
      transition: color var(--motion-fast), background var(--motion-fast), border-color var(--motion-fast);
    }
    .topbar-account:hover { color: var(--color-primary); border-color: var(--color-primary-border); }
    .topbar-account.active {
      color: var(--color-primary);
      border-color: var(--color-primary-border);
      background: var(--color-primary-soft);
      box-shadow: var(--glow-primary);
    }
    .topbar-account.active :global(svg) { color: var(--color-primary); }
    .topbar-account:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

    /* Floating pill bottom nav — the touch composition for phones AND
       tablets (Phase 2: closes the former 641-1024px navigation gap where
       neither the sidebar nor the pill was visible). */
    .mobile-nav {
      display: block;
      position: fixed; left: 50%; bottom: calc(14px + env(safe-area-inset-bottom, 0px));
      transform: translateX(-50%);
      z-index: 50;
      width: min(calc(100% - 24px), 480px);
    }
    .mobile-nav-inner {
      display: grid; grid-template-columns: repeat(6, 1fr);
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
      font-size: .58rem; font-weight: 700; letter-spacing: .02em;
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

    /* Phone-size refinements for the shared touch pill: tighter max
       width + compact labels (the tablet range keeps the roomier size). */
    .mobile-nav { width: min(calc(100% - 24px), 420px); }
    .mobile-nav a { font-size: .54rem; }
  }

  /* Desktop (≥1025px): the header account control on the right side —
     a quiet glass chip floating at the top-right of the content area,
     above the cinematic full-bleed pages (no persistent bar stealing
     vertical space). Opens the compact Account sheet (Phase 3). */
  @media (min-width: 1025px) {
    .header-account {
      position: fixed; top: 18px; right: 22px; z-index: 60;
      display: grid; place-items: center;
      width: 40px; height: 40px;
      border: 1px solid var(--color-border);
      border-radius: 12px;
      color: var(--color-text-muted);
      background: rgba(8, 11, 13, .55);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      cursor: pointer;
      transition: color var(--motion-fast), background var(--motion-fast), border-color var(--motion-fast);
    }
    .header-account:hover { color: var(--color-primary); border-color: var(--color-primary-border); }
    .header-account.active {
      color: var(--color-primary);
      border-color: var(--color-primary-border);
      background: var(--color-primary-soft);
      box-shadow: var(--glow-primary);
    }
    .header-account.active :global(svg) { color: var(--color-primary); }
    .header-account:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  }

  @media (max-width: 640px) {
    .page-shell.no-mobile-nav { padding-bottom: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .sidebar-link, .topbar-account, .header-account, .mobile-nav a { transition: none; }
  }
</style>
