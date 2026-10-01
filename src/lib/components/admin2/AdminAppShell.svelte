<script lang="ts">
  /**
   * Admin 2.0 — AdminAppShell (Phase B)
   *
   * The Neon Noir Control System shell. Replaces AdminShell.svelte
   * with a new architecture:
   *
   * Desktop (≥1024px):
   *   - Top context bar (brand + workspace + ⌘K command trigger + Configure + exit)
   *   - Collapsible sidebar with 6 workflow groups
   *   - Independent main scroll container
   *   - Ambient atmospheric lighting layer
   *   - Workspace fade transition on route change
   *
   * Mobile (<1024px):
   *   - Compact header (brand + workspace + ⌘K trigger)
   *   - Main content (full width)
   *   - Bottom navigation bar (5 primary destinations)
   *   - Secondary navigation via "More" sheet (all nav + configuration)
   *
   * The navigation groups follow the approved Admin 2.0 IA:
   *   COMMAND   → Overview
   *   CONTENT   → Media Library, Upload/Import, Missing Media
   *   HOSTING   → Providers, Assets, Sync
   *   OPERATIONS → Jobs, History, Attention
   *   SYSTEM    → API & Sources, Content Rules, Downloads, Integrations
   *   PEOPLE    → Analytics
   *
   * Phase B additions:
   *   - Route-aware active state (no fragile substring checks).
   *   - Active state survives direct nav, refresh, nested routes,
   *     query parameters, and dynamic route segments.
   *   - Command palette (⌘K / Ctrl+K) integrated in topbar.
   *   - "Configure" dropdown surfaces Defaults + Feature Control
   *     without polluting the primary SYSTEM nav.
   *   - Workspace transition (fade-in) on route change.
   *   - Mobile "More" sheet shows all groups + configuration.
   */

  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/state';
  import { tick } from 'svelte';
  import type { Snippet } from 'svelte';
  import {
    LayoutGrid, Library, Upload, AlertCircle, Server, HardDrive, RefreshCw,
    Activity, History, TriangleAlert, Settings, Layers, Download, Puzzle,
    BarChart3, PanelLeftClose, PanelLeft, X, ArrowLeft, MoreHorizontal,
    ChevronRight, Search, Command, ArrowRight
  } from 'lucide-svelte';
  import AdminCommandMenu from './AdminCommandMenu.svelte';

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
    /** Phase tag for placeholder destinations (e.g. "Phase C"). */
    phase?: string;
    /**
     * Optional route prefix used for active-state detection.
     * Defaults to `href`. Use this when a single nav item should
     * stay active across multiple sibling routes — e.g. "Analytics"
     * covers /admin/users/overview AND /admin/users/[id].
     */
    matchPrefix?: string;
    /** Marks placeholder destinations not yet implemented. */
    placeholder?: boolean;
  };

  type ConfigItem = {
    id: string;
    label: string;
    href: string;
    description: string;
  };

  let {
    active = '' as string,
    children
  }: {
    /** Optional override for the active nav item id. When empty, route-aware detection is used. */
    active?: string;
    children: Snippet;
  } = $props();

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
        { id: 'media-library', label: 'Media Library', href: '/admin/media/library', icon: Library, matchPrefix: '/admin/media/library' },
        { id: 'missing-media', label: 'Missing Media', href: '/admin/media/missing', icon: AlertCircle },
      ]
    },
    {
      id: 'hosting',
      label: 'Hosting',
      items: [
        { id: 'hosting', label: 'Hosting Control', href: '/admin/hosting', icon: Server, matchPrefix: '/admin/hosting' },
      ]
    },
    {
      id: 'system',
      label: 'System',
      items: [
        { id: 'api-sources', label: 'API & Sources', href: '/admin/system/api-sources', icon: Settings, matchPrefix: '/admin/system/api-sources' },
        { id: 'content-rules', label: 'Content Rules', href: '/admin/system/content-rules', icon: Layers, matchPrefix: '/admin/system/content-rules' },
        { id: 'downloads', label: 'Downloads', href: '/admin/system/downloads', icon: Download, matchPrefix: '/admin/system/downloads' },
        { id: 'integrations', label: 'Integrations', href: '/admin/system/integrations', icon: Puzzle, matchPrefix: '/admin/system/integrations' },
      ]
    },
    {
      id: 'people',
      label: 'People',
      items: [
        {
          id: 'analytics',
          label: 'Analytics',
          href: '/admin/analytics',
          icon: BarChart3,
          matchPrefix: '/admin/analytics',
        },
      ]
    },
  ];

  // Phase 2: configItems retired — Defaults + Feature Control were folded into
  // API & Sources / Content Rules as tabs/sheets in Phase 1. The topbar
  // Configure dropdown and the mobile "Configuration" section are removed
  // (no longer render an empty affordance).

  // Mobile bottom nav: 5 primary destinations.
  // Phase 2C consolidation: Upload removed from top-level nav (route
  // still works for deep links). Media Library is now the primary
  // content entry point. Hosting + Operations consolidated under Hosting.
  const mobileNav: NavItem[] = [
    { id: 'overview', label: 'Home', href: '/admin', icon: LayoutGrid },
    { id: 'media-library', label: 'Media', href: '/admin/media/library', icon: Library, matchPrefix: '/admin/media/library' },
    { id: 'hosting', label: 'Hosting', href: '/admin/hosting', icon: Server, matchPrefix: '/admin/hosting' },
    { id: 'analytics', label: 'Analytics', href: '/admin/analytics', icon: BarChart3, matchPrefix: '/admin/analytics' },
    { id: 'more', label: 'More', href: '#more', icon: MoreHorizontal },
  ];

  // ============================================================
  // ROUTE-AWARE ACTIVE STATE
  //
  // Uses `page.url.pathname` from `$app/state` for reactive,
  // SSR-safe route detection. No fragile substring checks —
  // we use proper route-relationship matching:
  //
  //   - Exact match for /admin (overview)
  //   - Equal OR child-of-prefix for everything else
  //   - matchPrefix override (e.g. Analytics covers /admin/users/*)
  //
  // Survives: direct nav, refresh, nested routes, query params,
  // dynamic route segments (e.g. /admin/users/[userId]).
  // ============================================================

  function isItemActive(item: NavItem, pathname: string): boolean {
    const prefix = item.matchPrefix ?? item.href;
    // Overview is exact-match only — /admin/foo must NOT highlight Overview.
    if (prefix === '/admin') {
      return pathname === '/admin';
    }
    // Equal, or proper child path (prefix + '/').
    return pathname === prefix || pathname.startsWith(prefix + '/');
  }

  const activeItemId = $derived.by(() => {
    // Explicit override (rare — used by overview page to disambiguate).
    if (active) {
      for (const g of navGroups) {
        for (const item of g.items) {
          if (item.id === active) return item.id;
        }
      }
    }
    // Route-aware detection.
    const pathname = page.url.pathname;
    for (const g of navGroups) {
      for (const item of g.items) {
        if (isItemActive(item, pathname)) return item.id;
      }
    }
    return '';
  });

  const activeGroup = $derived(
    navGroups.find(g => g.items.some(i => i.id === activeItemId))?.label ?? ''
  );

  // ============================================================
  // SIDEBAR COLLAPSE — persisted in localStorage
  // ============================================================

  const STORAGE_KEY = 'mavero:a2-sidebar-collapsed';
  let sidebarCollapsed = $state(false);
  let mobileMoreOpen = $state(false);
  let mobileMoreTrigger: HTMLElement | null = null;
  let mobileMoreEl = $state<HTMLElement | undefined>(undefined);
  let commandOpen = $state(false);
  let commandTrigger: HTMLElement | null = null;

  onMount(() => {
    try {
      sidebarCollapsed = localStorage.getItem(STORAGE_KEY) === 'true';
    } catch { /* SSR / no access */ }
    // ⌘K / Ctrl+K command palette
    window.addEventListener('keydown', handleGlobalKeydown);
  });

  onDestroy(() => {
    unlockBodyScroll();
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', handleGlobalKeydown);
    }
  });

  function handleGlobalKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
      event.preventDefault();
      commandOpen = true;
    }
  }

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

  // ============================================================
  // COMMAND PALETTE (⌘K)
  // ============================================================

  function openCommand(event?: Event) {
    if (event) event.preventDefault();
    commandOpen = true;
  }

  function closeCommand() {
    commandOpen = false;
  }

  // ============================================================
  // ROUTE-CHANGE EFFECTS — close overlays + workspace transition
  // ============================================================

  let lastPathname = typeof location !== 'undefined' ? location.pathname : '';
  let workspaceKey = $state(0);

  $effect(() => {
    const current = page.url.pathname;
    if (current !== lastPathname) {
      lastPathname = current;
      if (mobileMoreOpen) {
        mobileMoreOpen = false;
        unlockBodyScroll();
        mobileMoreTrigger = null;
      }
      // Bump key to retrigger workspace fade-in transition.
      workspaceKey += 1;
    }
  });
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
      <button
        class="a2-cmd-trigger"
        type="button"
        onclick={openCommand}
        aria-label="Open command palette"
      >
        <Search size={14} />
        <span class="a2-cmd-trigger-text">Search</span>
        <kbd class="a2-kbd">⌘K</kbd>
      </button>

      <!-- Phase 2: Configure dropdown removed — Defaults + Feature Control
           are now contextual tabs/sheets inside the System workspaces. The
           topbar no longer renders an empty Configure affordance. -->

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
              class:active={activeItemId === item.id}
              href={item.href}
              aria-current={activeItemId === item.id ? 'page' : undefined}
              title={sidebarCollapsed ? item.label : undefined}
            >
              <span class="a2-nav-icon"><Icon size={16} strokeWidth={activeItemId === item.id ? 2.2 : 1.7} /></span>
              {#if !sidebarCollapsed}
                <span class="a2-nav-text">{item.label}</span>
                {#if item.phase}
                  <span class="a2-nav-phase" title="Arrives in Phase {item.phase}">{item.phase}</span>
                {/if}
              {/if}
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
    <div class="a2-mobile-actions">
      <button
        class="a2-mobile-cmd"
        type="button"
        onclick={openCommand}
        aria-label="Open command palette"
      >
        <Search size={16} />
      </button>
      <a class="a2-mobile-exit" href="/discover" aria-label="Back to Mavero">
        <ArrowLeft size={16} />
      </a>
    </div>
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
                class:active={activeItemId === item.id}
                href={item.href}
                aria-current={activeItemId === item.id ? 'page' : undefined}
                onclick={closeMobileMore}
              >
                <span class="a2-nav-icon"><Icon size={16} /></span>
                <span class="a2-more-link-text">{item.label}</span>
                {#if item.phase}
                  <span class="a2-nav-phase">{item.phase}</span>
                {/if}
                <span class="a2-more-chevron"><ChevronRight size={14} /></span>
              </a>
            {/each}
          </div>
        {/each}

        <!-- Phase 2: empty Configuration group removed — configItems is
             empty after Phase 1 consolidated Defaults + Feature Control
             into the System workspaces. No dead section rendered. -->
      </nav>
    </div>
  {/if}

  <!-- ============================================================
       MAIN WORKSPACE
       ============================================================ -->
  <main class="a2-main a2-scroll">
    <div class="a2-workspace" data-key={workspaceKey}>
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
          class:active={activeItemId === item.id || (item.id === 'overview' && activeItemId === '')}
          href={item.href}
          aria-current={activeItemId === item.id || (item.id === 'overview' && activeItemId === '') ? 'page' : undefined}
        >
          <span class="a2-bottom-icon"><Icon size={20} /></span>
          <span class="a2-bottom-label">{item.label}</span>
        </a>
      {/if}
    {/each}
  </nav>

  <!-- ============================================================
       COMMAND PALETTE (⌘K)
       ============================================================ -->
  <AdminCommandMenu
    bind:open={commandOpen}
    {navGroups}
    onclose={closeCommand}
  />
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

  .a2-topbar-right {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
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

  /* ---- Command palette trigger ---- */
  .a2-cmd-trigger {
    display: inline-flex;
    align-items: center;
    gap: var(--a2-space-2);
    padding: 5px var(--a2-space-2) 5px var(--a2-space-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-sm);
    background: var(--a2-surface-2);
    color: var(--a2-text-muted);
    font-size: var(--a2-text-xs);
    font-weight: 500;
    cursor: pointer;
    transition: color var(--a2-motion-micro) var(--a2-ease-out),
                border-color var(--a2-motion-micro) var(--a2-ease-out),
                background var(--a2-motion-micro) var(--a2-ease-out);
  }
  .a2-cmd-trigger:hover {
    color: var(--a2-cyan);
    border-color: var(--a2-cyan-border);
    background: var(--a2-cyan-soft);
  }
  .a2-cmd-trigger-text {
    color: var(--a2-text-muted);
  }
  .a2-kbd {
    display: inline-flex;
    align-items: center;
    padding: 1px 5px;
    border: 1px solid var(--a2-border-strong);
    border-radius: var(--a2-radius-xs);
    background: var(--a2-surface-3);
    color: var(--a2-text-dim);
    font-family: var(--a2-font-mono);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  /* Phase 2: Configure dropdown CSS removed — the dropdown was retired
     when Defaults + Feature Control were folded into the System
     workspaces as tabs/sheets in Phase 1. */

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
  .a2-nav-link:focus-visible {
    outline: 2px solid var(--a2-cyan);
    outline-offset: -2px;
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
    flex: 1;
  }
  .a2-nav-phase {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    padding: 1px 5px;
    border-radius: var(--a2-radius-xs);
    background: var(--a2-surface-3);
    border: 1px solid var(--a2-border-strong);
    color: var(--a2-text-dim);
    font-family: var(--a2-font-mono);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.05em;
    flex-shrink: 0;
  }
  .a2-nav-link.active .a2-nav-phase {
    color: var(--a2-cyan);
    border-color: var(--a2-cyan-border);
    background: var(--a2-cyan-soft);
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
    height: var(--a2-topbar-h-safe);
    padding-top: env(safe-area-inset-top, 0px);
    z-index: 40;
    align-items: center;
    justify-content: space-between;
    padding-left: var(--a2-space-4);
    padding-right: var(--a2-space-4);
    background: var(--a2-glass);
    backdrop-filter: blur(16px) saturate(140%);
    border-bottom: 1px solid var(--a2-border);
  }
  .a2-mobile-brand {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
    overflow: hidden;
    min-width: 0;
  }
  .a2-mobile-actions {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
  }
  .a2-mobile-cmd {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: var(--a2-radius-sm);
    border: none;
    background: transparent;
    color: var(--a2-text-muted);
    cursor: pointer;
    transition: color var(--a2-motion-micro) var(--a2-ease-out),
                background var(--a2-motion-micro) var(--a2-ease-out);
  }
  .a2-mobile-cmd:hover {
    color: var(--a2-cyan);
    background: var(--a2-cyan-soft);
  }
  .a2-mobile-exit {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
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
    padding: var(--a2-space-5) var(--a2-space-4) calc(var(--a2-space-8) + env(safe-area-inset-bottom, 0px));
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
    width: 44px;
    height: 44px;
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
  .a2-more-link:focus-visible {
    outline: 2px solid var(--a2-cyan);
    outline-offset: -2px;
  }
  .a2-more-link-text {
    flex: 1;
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
    animation: a2-workspace-in var(--a2-motion-normal) var(--a2-ease-out);
  }
  @keyframes a2-workspace-in {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
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
    justify-content: center;
    gap: 2px;
    min-width: 44px;
    min-height: 44px;
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
  .a2-bottom-item:focus-visible {
    outline: 2px solid var(--a2-cyan);
    outline-offset: -2px;
    border-radius: var(--a2-radius-sm);
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
    .a2-cmd-trigger-text { display: none; }
    .a2-cmd-trigger { padding: 5px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .a2-more-sheet,
    .a2-more-overlay,
    .a2-workspace { animation: none; }
    .a2-status-dot { animation: none; }
    .a2-sidebar, .a2-topbar, .a2-main { transition: none; }
  }

  /* ============================================================
     Admin cyan override for the root layout's nav-spinner/nav-progress.
     The root layout renders .nav-spinner and .nav-progress as DOM
     siblings AFTER .a2-shell, so the general-sibling combinator (~)
     scopes the override to admin routes only.
     Specificity (0,4,0) beats the root layout's scoped (0,2,0).
     User-facing routes (no .a2-shell) keep the green default.
     ============================================================ */
  .a2-shell ~ :global(.nav-spinner) {
    border: 1px solid rgba(0, 217, 255, .22);
    box-shadow: 0 0 14px rgba(0, 217, 255, .3), 0 2px 8px rgba(0, 0, 0, .4);
  }
  .a2-shell ~ :global(.nav-spinner) :global(.nav-spinner-ring) {
    border-top-color: var(--a2-cyan, #00d9ff);
  }
  .a2-shell ~ :global(.nav-progress) {
    background: linear-gradient(90deg, var(--a2-cyan, #00d9ff), var(--a2-cyan, #00d9ff));
  }
  @media (prefers-reduced-motion: reduce) {
    .a2-shell ~ :global(.nav-spinner) :global(.nav-spinner-ring) {
      border-top-color: var(--a2-cyan, #00d9ff);
      border-right-color: var(--a2-cyan, #00d9ff);
    }
  }
</style>
