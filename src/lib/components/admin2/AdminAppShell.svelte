<script lang="ts">
  /**
   * Admin 2.0 — AdminAppShell
   *
   * The Neon Noir Control System shell. Replaces AdminShell.svelte
   * with a new architecture:
   *
   * Desktop (≥1024px):
   *   - Top context bar (brand + workspace + search + back-to-app)
   *   - Collapsible sidebar with 5 workflow groups
   *   - Independent main scroll container
   *   - Ambient atmospheric lighting layer
   *
   * Mobile (<1024px):
   *   - Compact header (brand + workspace)
   *   - Main content (full width)
   *   - Bottom navigation bar (5 primary destinations)
   *   - Secondary navigation via "More" sheet
   *
   * The navigation groups follow the approved Admin 2.0 IA:
   *   COMMAND   → Overview
   *   CONTENT   → Media Library, Upload, Missing Media
   *   HOSTING   → Providers, Assets, Sync
   *   OPERATIONS → Jobs, History, Attention
   *   SYSTEM    → API & Sources, Content Rules, Downloads, Integrations
   *   PEOPLE    → Analytics
   *
   * Existing routes that don't yet have Admin 2.0 pages are included
   * in the nav but point to their current URLs — the shell doesn't
   * break existing functionality.
   */

  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/state';
  import { tick } from 'svelte';
  import type { Snippet } from 'svelte';
  import {
    LayoutGrid, Library, Upload, AlertCircle, Server, HardDrive, RefreshCw,
    Activity, History, TriangleAlert, Settings, Layers, Download, Puzzle,
    BarChart3, PanelLeftClose, PanelLeft, Menu, X, ArrowLeft, MoreHorizontal,
    ChevronRight
  } from 'lucide-svelte';

  type NavGroup = {
    id: string;
    label: string;
    items: NavItem[];
  };

  type NavItem = {
    id: string;
    label: string;
    href: string;
    icon: typeof LayoutGrid;
    badge?: string;
    active?: boolean;
  };

  let {
    active = '' as string,
    children
  }: {
    active?: string;
    children: Snippet;
  } = $props();

  // ============================================================
  // NAVIGATION — Admin 2.0 Information Architecture
  // ============================================================

  const navGroups: NavGroup[] = [
    {
      id: 'command',
      label: 'Command',
      items: [
        { id: 'overview', label: 'Overview', href: '/admin', icon: LayoutGrid },
      ]
    },
    {
      id: 'content',
      label: 'Content',
      items: [
        { id: 'media-library', label: 'Media Library', href: '/admin/media/library', icon: Library },
        { id: 'upload', label: 'Upload / Import', href: '/admin/media/upload', icon: Upload },
        { id: 'missing-media', label: 'Missing Media', href: '/admin/media/missing', icon: AlertCircle },
      ]
    },
    {
      id: 'hosting',
      label: 'Hosting',
      items: [
        { id: 'providers', label: 'Providers', href: '/admin/providers', icon: Server },
        { id: 'assets', label: 'Assets', href: '/admin/media/assets', icon: HardDrive },
        { id: 'sync', label: 'Sync', href: '/admin/media/sync', icon: RefreshCw },
      ]
    },
    {
      id: 'operations',
      label: 'Operations',
      items: [
        { id: 'jobs', label: 'Jobs', href: '/admin/media/operations', icon: Activity },
        { id: 'history', label: 'History', href: '/admin/media/history', icon: History },
        { id: 'attention', label: 'Attention', href: '/admin/media/stale', icon: TriangleAlert },
      ]
    },
    {
      id: 'system',
      label: 'System',
      items: [
        { id: 'sources', label: 'API & Sources', href: '/admin/sources', icon: Settings },
        { id: 'categories', label: 'Content Rules', href: '/admin/categories', icon: Layers },
        { id: 'downloaders', label: 'Downloads', href: '/admin/downloaders', icon: Download },
        { id: 'addons', label: 'Integrations', href: '/admin/addons', icon: Puzzle },
        { id: 'defaults', label: 'Defaults', href: '/admin/defaults', icon: Settings },
        { id: 'feature-control', label: 'Feature Control', href: '/admin/feature-control', icon: Settings },
      ]
    },
    {
      id: 'people',
      label: 'People',
      items: [
        { id: 'analytics', label: 'Analytics', href: '/admin/users/overview', icon: BarChart3 },
      ]
    },
  ];

  // Mobile bottom nav: 5 primary destinations
  const mobileNav: NavItem[] = [
    { id: 'overview', label: 'Home', href: '/admin', icon: LayoutGrid },
    { id: 'media-library', label: 'Media', href: '/admin/media/library', icon: Library },
    { id: 'upload', label: 'Upload', href: '/admin/media/upload', icon: Upload },
    { id: 'jobs', label: 'Jobs', href: '/admin/media/operations', icon: Activity },
    { id: 'more', label: 'More', href: '#more', icon: MoreHorizontal },
  ];

  // ============================================================
  // SIDEBAR COLLAPSE — persisted in localStorage
  // ============================================================

  const STORAGE_KEY = 'mavero:a2-sidebar-collapsed';
  let sidebarCollapsed = $state(false);
  let mobileMoreOpen = $state(false);
  let mobileMoreTrigger: HTMLElement | null = null;
  let mobileMoreEl = $state<HTMLElement | undefined>(undefined);

  onMount(() => {
    try {
      sidebarCollapsed = localStorage.getItem(STORAGE_KEY) === 'true';
    } catch { /* SSR / no access */ }
  });

  onDestroy(() => {
    unlockBodyScroll();
  });

  function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
    try { localStorage.setItem(STORAGE_KEY, String(sidebarCollapsed)); } catch { /* no access */ }
  }

  $effect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.style.setProperty(
        '--a2-sidebar-current',
        sidebarCollapsed ? 'var(--a2-sidebar-collapsed)' : 'var(--a2-sidebar-w)'
      );
    }
  });

  // ============================================================
  // BODY SCROLL LOCK for mobile "More" sheet
  // ============================================================

  function lockBodyScroll() {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-a2-drawer-open', '');
    }
  }

  function unlockBodyScroll() {
    if (typeof document !== 'undefined') {
      document.documentElement.removeAttribute('data-a2-drawer-open');
    }
  }

  function openMobileMore(event: Event) {
    if (mobileNav[4]?.id === 'more') {
      // Prevent the href="#more" from navigating
      event.preventDefault();
    }
    mobileMoreTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    mobileMoreOpen = true;
    lockBodyScroll();
    void tick().then(() => {
      mobileMoreEl?.querySelector<HTMLElement>('.a2-more-close')?.focus();
    });
  }

  function closeMobileMore() {
    mobileMoreOpen = false;
    unlockBodyScroll();
    mobileMoreTrigger?.focus();
    mobileMoreTrigger = null;
  }

  function handleMoreKeydown(event: KeyboardEvent) {
    if (!mobileMoreOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMobileMore();
      return;
    }
    if (event.key !== 'Tab' || !mobileMoreEl) return;
    const focusable = [...mobileMoreEl.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // Close mobile "More" on route change
  let lastPathname = typeof location !== 'undefined' ? location.pathname : '';
  $effect(() => {
    const current = page.url.pathname;
    if (current !== lastPathname) {
      lastPathname = current;
      if (mobileMoreOpen) {
        mobileMoreOpen = false;
        unlockBodyScroll();
        mobileMoreTrigger = null;
      }
    }
  });

  // Determine active group for the top context bar
  const activeGroup = $derived(
    navGroups.find(g => g.items.some(i => i.id === active))?.label ?? ''
  );
</script>

<div class="a2-shell">
  <!-- Ambient atmosphere layer -->
  <div class="a2-ambient" aria-hidden="true"></div>

  <!-- ============================================================
       DESKTOP TOP CONTEXT BAR
       ============================================================ -->
  <header class="a2-topbar">
    <div class="a2-topbar-left">
      <button
        class="a2-sidebar-toggle"
        type="button"
        onclick={toggleSidebar}
        aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {#if sidebarCollapsed}<PanelLeft size={16} />{:else}<PanelLeftClose size={16} />{/if}
      </button>
      <div class="a2-brand-block">
        <span class="a2-brand-name">MAVERO</span>
        <span class="a2-brand-sep">/</span>
        <span class="a2-brand-context">{activeGroup || 'Admin'}</span>
      </div>
    </div>
    <div class="a2-topbar-right">
      <a class="a2-back-link" href="/discover" title="Back to Mavero">
        <ArrowLeft size={14} />
        <span>Exit</span>
      </a>
    </div>
  </header>

  <!-- ============================================================
       DESKTOP SIDEBAR (≥1024px)
       ============================================================ -->
  <aside class="a2-sidebar a2-scroll" aria-label="Admin navigation">
    <nav class="a2-nav">
      {#each navGroups as group}
        <div class="a2-nav-group">
          {#if !sidebarCollapsed}
            <div class="a2-nav-label">{group.label}</div>
          {/if}
          {#each group.items as item}
            {@const Icon = item.icon}
            <a
              class="a2-nav-link"
              class:active={active === item.id}
              href={item.href}
              aria-current={active === item.id ? 'page' : undefined}
              title={sidebarCollapsed ? item.label : undefined}
            >
              <span class="a2-nav-icon"><Icon size={16} strokeWidth={active === item.id ? 2.2 : 1.7} /></span>
              {#if !sidebarCollapsed}<span class="a2-nav-text">{item.label}</span>{/if}
            </a>
          {/each}
        </div>
      {/each}
    </nav>

    <div class="a2-sidebar-foot">
      <div class="a2-sidebar-divider"></div>
      <div class="a2-status">
        <span class="a2-status-dot" aria-hidden="true"></span>
        {#if !sidebarCollapsed}<span class="a2-status-text">Operational</span>{/if}
      </div>
    </div>
  </aside>

  <!-- ============================================================
       MOBILE HEADER (<1024px)
       ============================================================ -->
  <header class="a2-mobile-header">
    <div class="a2-mobile-brand">
      <span class="a2-brand-name">MAVERO</span>
      <span class="a2-brand-sep">/</span>
      <span class="a2-brand-context">{activeGroup || 'Admin'}</span>
    </div>
    <a class="a2-mobile-exit" href="/discover" aria-label="Back to Mavero">
      <ArrowLeft size={16} />
    </a>
  </header>

  <!-- ============================================================
       MOBILE "MORE" SHEET
       ============================================================ -->
  {#if mobileMoreOpen}
    <div class="a2-more-overlay" onclick={closeMobileMore} aria-hidden="true"></div>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="a2-more-sheet a2-scroll"
      bind:this={mobileMoreEl}
      role="dialog"
      aria-modal="true"
      aria-label="More navigation"
      tabindex="-1"
      onkeydown={handleMoreKeydown}
    >
      <div class="a2-more-head">
        <span class="a2-more-title">All Navigation</span>
        <button class="a2-more-close" type="button" onclick={closeMobileMore} aria-label="Close navigation">
          <X size={18} />
        </button>
      </div>
      <nav class="a2-more-nav" aria-label="All admin navigation">
        {#each navGroups as group}
          <div class="a2-more-group">
            <div class="a2-nav-label">{group.label}</div>
            {#each group.items as item}
              {@const Icon = item.icon}
              <a
                class="a2-more-link"
                class:active={active === item.id}
                href={item.href}
                aria-current={active === item.id ? 'page' : undefined}
                onclick={closeMobileMore}
              >
                <span class="a2-nav-icon"><Icon size={16} /></span>
                <span>{item.label}</span>
                <ChevronRight size={14} class="a2-more-chevron" />
              </a>
            {/each}
          </div>
        {/each}
      </nav>
    </div>
  {/if}

  <!-- ============================================================
       MAIN WORKSPACE
       ============================================================ -->
  <main class="a2-main a2-scroll">
    <div class="a2-workspace">
      {@render children()}
    </div>
  </main>

  <!-- ============================================================
       MOBILE BOTTOM NAVIGATION (<1024px)
       ============================================================ -->
  <nav class="a2-bottom-nav" aria-label="Mobile navigation">
    {#each mobileNav as item}
      {@const Icon = item.icon}
      {#if item.id === 'more'}
        <button
          class="a2-bottom-item"
          class:active={mobileMoreOpen}
          onclick={openMobileMore}
          aria-label="More navigation"
          aria-expanded={mobileMoreOpen}
        >
          <span class="a2-bottom-icon"><Icon size={20} /></span>
          <span class="a2-bottom-label">{item.label}</span>
        </button>
      {:else}
        <a
          class="a2-bottom-item"
          class:active={active === item.id || (item.id === 'overview' && active === '')}
          href={item.href}
          aria-current={active === item.id || (item.id === 'overview' && active === '') ? 'page' : undefined}
        >
          <span class="a2-bottom-icon"><Icon size={20} /></span>
          <span class="a2-bottom-label">{item.label}</span>
        </a>
      {/if}
    {/each}
  </nav>
</div>

<style>
  .a2-shell {
    display: block;
    min-height: 100dvh;
    background: var(--a2-bg);
  }

  /* ============================================================
     TOP CONTEXT BAR (desktop)
     ============================================================ */
  .a2-topbar {
    position: fixed;
    top: 0; left: var(--a2-sidebar-current); right: 0;
    height: var(--a2-topbar-h);
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--a2-space-5);
    background: var(--a2-glass);
    backdrop-filter: blur(16px) saturate(140%);
    border-bottom: 1px solid var(--a2-border);
    transition: left var(--a2-motion-normal) var(--a2-ease-out);
  }

  .a2-topbar-left {
    display: flex;
    align-items: center;
    gap: var(--a2-space-3);
  }

  .a2-sidebar-toggle {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: var(--a2-radius-sm);
    background: transparent;
    color: var(--a2-text-muted);
    cursor: pointer;
    transition: color var(--a2-motion-micro) var(--a2-ease-out),
                background var(--a2-motion-micro) var(--a2-ease-out);
  }
  .a2-sidebar-toggle:hover {
    color: var(--a2-cyan);
    background: var(--a2-cyan-soft);
  }

  .a2-brand-block {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
  }
  .a2-brand-name {
    font-family: var(--a2-font-sans);
    font-weight: 800;
    font-size: var(--a2-text-sm);
    letter-spacing: 0.05em;
    color: var(--a2-text-bright);
  }
  .a2-brand-sep {
    color: var(--a2-text-dim);
    font-size: var(--a2-text-sm);
  }
  .a2-brand-context {
    font-family: var(--a2-font-sans);
    font-weight: 500;
    font-size: var(--a2-text-sm);
    color: var(--a2-cyan);
  }

  .a2-back-link {
    display: inline-flex;
    align-items: center;
    gap: var(--a2-space-1);
    padding: var(--a2-space-1) var(--a2-space-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text-muted);
    font-size: var(--a2-text-xs);
    font-weight: 600;
    text-decoration: none;
    transition: color var(--a2-motion-micro) var(--a2-ease-out),
                border-color var(--a2-motion-micro) var(--a2-ease-out),
                background var(--a2-motion-micro) var(--a2-ease-out);
  }
  .a2-back-link:hover {
    color: var(--a2-text);
    border-color: var(--a2-border-strong);
    background: var(--a2-surface-3);
  }

  /* ============================================================
     SIDEBAR (desktop ≥1024px)
     ============================================================ */
  .a2-sidebar {
    position: fixed;
    top: 0; left: 0; bottom: 0;
    width: var(--a2-sidebar-current);
    height: 100dvh;
    z-index: 50;
    display: flex;
    flex-direction: column;
    padding: var(--a2-space-5) var(--a2-space-2) var(--a2-space-3);
    background: var(--a2-surface-1);
    border-right: 1px solid var(--a2-border);
    overflow-y: auto;
    transition: width var(--a2-motion-normal) var(--a2-ease-out);
  }

  .a2-nav {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-1);
  }

  .a2-nav-group {
    margin-bottom: var(--a2-space-3);
  }

  .a2-nav-label {
    padding: var(--a2-space-2) var(--a2-space-3);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-2xs);
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--a2-text-dim);
  }

  .a2-nav-link {
    display: flex;
    align-items: center;
    gap: var(--a2-space-3);
    padding: var(--a2-space-2) var(--a2-space-3);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text-muted);
    text-decoration: none;
    font-size: var(--a2-text-sm);
    font-weight: 500;
    transition: color var(--a2-motion-micro) var(--a2-ease-out),
                background var(--a2-motion-micro) var(--a2-ease-out),
                border-color var(--a2-motion-micro) var(--a2-ease-out);
    position: relative;
  }
  .a2-nav-link:hover {
    color: var(--a2-text);
    background: var(--a2-surface-2);
  }
  .a2-nav-link.active {
    color: var(--a2-cyan);
    background: var(--a2-cyan-soft);
    box-shadow: inset 2px 0 0 var(--a2-cyan);
  }
  .a2-nav-link.active .a2-nav-icon {
    filter: drop-shadow(0 0 6px rgba(0, 217, 255, 0.4));
  }

  .a2-nav-icon {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    flex-shrink: 0;
  }
  .a2-nav-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Collapsed: center icons */
  .a2-sidebar:has(~ .a2-topbar .a2-sidebar-toggle) .a2-nav-text {
    display: none;
  }

  .a2-sidebar-foot {
    margin-top: auto;
    padding-top: var(--a2-space-3);
  }
  .a2-sidebar-divider {
    height: 1px;
    background: var(--a2-border);
    margin-bottom: var(--a2-space-3);
  }
  .a2-status {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
    padding: var(--a2-space-2) var(--a2-space-3);
  }
  .a2-status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--a2-green);
    box-shadow: 0 0 8px rgba(0, 255, 156, 0.5);
    animation: a2-pulse-dot var(--a2-motion-ambient) ease-in-out infinite;
  }
  @keyframes a2-pulse-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  .a2-status-text {
    font-size: var(--a2-text-2xs);
    font-weight: 600;
    color: var(--a2-text-dim);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  /* ============================================================
     MOBILE HEADER (<1024px)
     ============================================================ */
  .a2-mobile-header {
    display: none;
    position: fixed;
    top: 0; left: 0; right: 0;
    height: var(--a2-topbar-h);
    z-index: 40;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--a2-space-4);
    background: var(--a2-glass);
    backdrop-filter: blur(16px) saturate(140%);
    border-bottom: 1px solid var(--a2-border);
  }
  .a2-mobile-brand {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
  }
  .a2-mobile-exit {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text-muted);
    text-decoration: none;
    transition: color var(--a2-motion-micro) var(--a2-ease-out),
                background var(--a2-motion-micro) var(--a2-ease-out);
  }
  .a2-mobile-exit:hover {
    color: var(--a2-cyan);
    background: var(--a2-cyan-soft);
  }

  /* ============================================================
     MOBILE "MORE" SHEET
     ============================================================ */
  .a2-more-overlay {
    position: fixed;
    inset: 0;
    z-index: 90;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    animation: a2-fade-in var(--a2-motion-fast) var(--a2-ease-out);
  }
  .a2-more-sheet {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    z-index: 91;
    max-height: 75dvh;
    overflow-y: auto;
    background: var(--a2-surface-2);
    border-top: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-xl) var(--a2-radius-xl) 0 0;
    padding: var(--a2-space-5) var(--a2-space-4) var(--a2-space-8);
    animation: a2-slide-up var(--a2-motion-slow) var(--a2-ease-out);
  }
  @keyframes a2-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes a2-slide-up {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
  }

  .a2-more-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--a2-space-5);
  }
  .a2-more-title {
    font-family: var(--a2-font-sans);
    font-weight: 700;
    font-size: var(--a2-text-lg);
    color: var(--a2-text-bright);
  }
  .a2-more-close {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border: none;
    border-radius: var(--a2-radius-md);
    background: var(--a2-surface-3);
    color: var(--a2-text-muted);
    cursor: pointer;
  }

  .a2-more-group {
    margin-bottom: var(--a2-space-4);
  }
  .a2-more-link {
    display: flex;
    align-items: center;
    gap: var(--a2-space-3);
    padding: var(--a2-space-3) var(--a2-space-2);
    border-radius: var(--a2-radius-sm);
    color: var(--a2-text-muted);
    text-decoration: none;
    font-size: var(--a2-text-base);
    font-weight: 500;
  }
  .a2-more-link.active {
    color: var(--a2-cyan);
    background: var(--a2-cyan-soft);
  }
  .a2-more-chevron {
    margin-left: auto;
    opacity: 0.4;
  }

  /* ============================================================
     MAIN WORKSPACE
     ============================================================ */
  .a2-main {
    margin-left: var(--a2-sidebar-current);
    height: 100dvh;
    overflow-y: auto;
    overflow-x: hidden;
    padding-top: var(--a2-topbar-h);
    background: var(--a2-bg);
    transition: margin-left var(--a2-motion-normal) var(--a2-ease-out);
  }

  .a2-workspace {
    padding: var(--a2-space-6);
    min-height: calc(100dvh - var(--a2-topbar-h));
  }

  /* ============================================================
     MOBILE BOTTOM NAVIGATION
     ============================================================ */
  .a2-bottom-nav {
    display: none;
    position: fixed;
    bottom: 0; left: 0; right: 0;
    height: var(--a2-mobile-nav-h);
    z-index: 45;
    background: var(--a2-glass);
    backdrop-filter: blur(16px) saturate(140%);
    border-top: 1px solid var(--a2-border);
    align-items: center;
    justify-content: space-around;
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  .a2-bottom-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: var(--a2-space-1) var(--a2-space-2);
    color: var(--a2-text-dim);
    text-decoration: none;
    font-size: var(--a2-text-2xs);
    font-weight: 600;
    background: none;
    border: none;
    cursor: pointer;
    transition: color var(--a2-motion-micro) var(--a2-ease-out);
    -webkit-tap-highlight-color: transparent;
  }
  .a2-bottom-item.active {
    color: var(--a2-cyan);
  }
  .a2-bottom-icon {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
  }
  .a2-bottom-label {
    font-size: 9px;
    letter-spacing: 0.02em;
  }

  /* ============================================================
     RESPONSIVE
     ============================================================ */
  @media (min-width: 1024px) {
    .a2-mobile-header { display: none; }
    .a2-bottom-nav { display: none; }
    .a2-topbar { display: flex; }
    .a2-sidebar { display: flex; }
    .a2-main { margin-left: var(--a2-sidebar-current); padding-top: var(--a2-topbar-h); }
    .a2-workspace { padding: var(--a2-space-6); }
  }

  @media (max-width: 1023px) {
    .a2-topbar { display: none; }
    .a2-sidebar { display: none; }
    .a2-mobile-header { display: flex; }
    .a2-bottom-nav { display: flex; }
    .a2-main {
      margin-left: 0;
      height: auto;
      min-height: 100dvh;
      padding-top: var(--a2-topbar-h-safe);
      padding-bottom: var(--a2-mobile-nav-h-safe);
    }
    .a2-workspace {
      padding: var(--a2-space-4);
      min-height: calc(100dvh - var(--a2-topbar-h-safe) - var(--a2-mobile-nav-h-safe));
    }
  }

  @media (max-width: 640px) {
    .a2-workspace { padding: var(--a2-space-3); }
    .a2-brand-context { font-size: var(--a2-text-xs); }
  }

  @media (prefers-reduced-motion: reduce) {
    .a2-more-sheet { animation: none; }
    .a2-more-overlay { animation: none; }
    .a2-status-dot { animation: none; }
    .a2-sidebar, .a2-topbar, .a2-main { transition: none; }
  }
</style>
