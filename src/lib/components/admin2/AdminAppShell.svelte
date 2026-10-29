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
   *
   * MAV-FOCUSED (2026-10): the mobile "More" sheet + the "More" bottom-
   * nav item were removed. Every route is reachable through the desktop
   * sidebar (≥1024px) OR the Overview quick-action cards + System Status
   * metric cards (mobile). No duplicate navigation surface remains.
   */

  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/state';
  import type { Snippet } from 'svelte';
  import {
    LayoutGrid, Library, Upload, AlertCircle, HardDrive, RefreshCw,
    Activity, History, TriangleAlert, Settings, Layers, Download, Puzzle,
    BarChart3, PanelLeftClose, PanelLeft, ArrowLeft,
    Search, Command, ArrowRight, Tv, Menu, X, Radar
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
    /**
     * FILL MODE (2026-10-16 layout round) — opt-in per page. Set by pages
     * that own an INTERNAL scroll region (Media Library's cards list).
     * When true, `.a2-main` stops being the scroller (overflow: hidden;
     * exactly 100dvh tall between the fixed header and the mobile bottom
     * nav) and the workspace stretches into a flex column, so the page's
     * own cards region becomes the ONLY scroll container and its toolbar
     * NEVER scrolls away.
     *
     * Root cause this fixes: the previous design relied on
     * `position: sticky` for the library toolbar, but `.a2-main` keeps
     * `overflow-y: auto` from its base rule even in the <1024px media
     * query (where `height: auto` makes it grow with content and the
     * DOCUMENT scrolls instead). An `overflow: auto` ancestor is the
     * sticky element's scrollport even when it never actually scrolls —
     * so on mobile the toolbar never received a sticky offset and simply
     * scrolled away with the page while the first card slid under the
     * fixed admin header. Fill mode removes the need for sticky entirely.
     *
     * Pages that do NOT opt in keep the exact previous behavior
     * (mobile: document scroll; desktop: `.a2-main` internal scroll).
     */
    fill = false as boolean,
    children
  }: {
    /** Optional override for the active nav item id. When empty, route-aware detection is used. */
    active?: string;
    /** Opt into the fixed-height workspace layout (see comment above). */
    fill?: boolean;
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
      id: 'system',
      label: 'Settings',
      items: [
        { id: 'api-sources', label: 'API & Sources', href: '/admin/system/api-sources', icon: Settings, matchPrefix: '/admin/system/api-sources' },
        { id: 'feature-control', label: 'Feature Control', href: '/admin/system/feature-control', icon: Layers, matchPrefix: '/admin/system/feature-control' },
        { id: 'livetv', label: 'Live TV', href: '/admin/system/livetv', icon: Tv, matchPrefix: '/admin/system/livetv' },
        { id: 'direct-stream', label: 'DirectStream', href: '/admin/system/direct-stream', icon: Radar, matchPrefix: '/admin/system/direct-stream' },
        { id: 'downloads', label: 'Downloads', href: '/admin/system/downloads', icon: Download, matchPrefix: '/admin/system/downloads' },
        { id: 'integrations', label: 'Add-ons & Extensions', href: '/admin/system/integrations', icon: Puzzle, matchPrefix: '/admin/system/integrations' },
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
  // Hosting Control removed — replaced with Missing Media (the demand-
  // tracking surface that admins need quick access to).
  // 2026-10 admin restructure round 3: a 5th "More" item was added. The
  // More item opens a drawer that surfaces the entire Settings group
  // (API & Sources, Feature Control, Live TV, Downloads, Integrations)
  // — without it, Feature Control was unreachable on mobile. The "More"
  // item is special-cased below (no href — it toggles the drawer).
  const mobileNav: NavItem[] = [
    { id: 'overview', label: 'Home', href: '/admin', icon: LayoutGrid },
    { id: 'media-library', label: 'Media', href: '/admin/media/library', icon: Library, matchPrefix: '/admin/media/library' },
    { id: 'missing-media', label: 'Missing', href: '/admin/media/missing', icon: AlertCircle },
    { id: 'analytics', label: 'Analytics', href: '/admin/analytics', icon: BarChart3, matchPrefix: '/admin/analytics' },
    { id: 'more', label: 'More', href: '#more', icon: Menu },
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
  let commandOpen = $state(false);
  let commandTrigger: HTMLElement | null = null;

  // ============================================================
  // MOBILE MORE SHEET (2026-10 admin restructure round 3).
  // The 4-item bottom-nav (Home / Media / Missing / Analytics) cannot
  // fit the entire Settings group, so the More sheet surfaces the rest
  // (API & Sources, Feature Control, Live TV, Downloads, Integrations).
  // Tapping any link closes the sheet and navigates. The sheet is
  // scrollable, focus-trapped via role="dialog" + aria-modal, and
  // closes on Escape / overlay tap / route change.
  // ============================================================
  let moreOpen = $state(false);
  let moreTrigger = $state<HTMLElement | null>(null);

  function openMore(event?: Event) {
    if (event) event.preventDefault();
    moreOpen = true;
  }
  function closeMore() {
    moreOpen = false;
    moreTrigger?.focus();
  }
  function handleMoreKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMore();
    }
  }
  // Close the More sheet on route change so back/forward navigation
  // never leaves it open over the next page.
  $effect(() => {
    void page.url.pathname;
    moreOpen = false;
  });

  onMount(() => {
    try {
      sidebarCollapsed = localStorage.getItem(STORAGE_KEY) === 'true';
    } catch { /* SSR / no access */ }
    // ⌘K / Ctrl+K command palette
    window.addEventListener('keydown', handleGlobalKeydown);
  });

  onDestroy(() => {
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
  // ROUTE-CHANGE EFFECTS — workspace transition
  // ============================================================

  let lastPathname = typeof location !== 'undefined' ? location.pathname : '';
  let workspaceKey = $state(0);

  $effect(() => {
    const current = page.url.pathname;
    if (current !== lastPathname) {
      lastPathname = current;
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
       MOBILE "MORE" SHEET — RESTORED (2026-10 admin restructure
       round 3). The previous MAV-FOCUSED redesign removed the More
       sheet because every route was assumed reachable via Overview
       cards — but the Feature Control route (extracted from the
       deleted Content Rules in the 2026-10 restructure) had no
       Overview card, leaving it unreachable on mobile. The More
       sheet now surfaces the entire Settings group; the bottom-nav
       "More" item toggles it.
       ============================================================ -->
  {#if moreOpen}
    <div
      class="a2-more-overlay"
      onclick={closeMore}
      onkeydown={handleMoreKeydown}
      role="presentation"
    ></div>
    <div
      class="a2-more-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="a2-more-title"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={handleMoreKeydown}
    >
      <header class="a2-more-head">
        <h2 id="a2-more-title" class="a2-more-title">Settings</h2>
        <button
          type="button"
          class="a2-more-close"
          onclick={closeMore}
          aria-label="Close settings"
        >
          <X size={18} />
        </button>
      </header>
      <div class="a2-more-body">
        {#each navGroups as group}
          {#if group.id === 'system'}
            <p class="a2-more-group-label">{group.label}</p>
            <nav class="a2-more-list" aria-label={group.label}>
              {#each group.items as item}
                {@const Icon = item.icon}
                <a
                  class="a2-more-link"
                  class:active={activeItemId === item.id}
                  href={item.href}
                  aria-current={activeItemId === item.id ? 'page' : undefined}
                  onclick={closeMore}
                >
                  <span class="a2-more-link-icon"><Icon size={18} /></span>
                  <span class="a2-more-link-label">{item.label}</span>
                </a>
              {/each}
            </nav>
          {/if}
        {/each}
      </div>
    </div>
  {/if}

  <!-- ============================================================
       MAIN WORKSPACE
       ============================================================ -->
  <main class="a2-main a2-scroll" class:a2-main-fill={fill}>
    <div class="a2-workspace" data-key={workspaceKey}>
      {@render children()}
    </div>
  </main>

  <!-- ============================================================
       MOBILE BOTTOM NAVIGATION (<1024px) — 5 primary destinations.
       2026-10 admin restructure round 3: the "More" item was added
       back. It is special-cased below — instead of an <a href>, it
       renders a <button> that toggles the More sheet (the drawer
       above). The other 4 items keep the existing <a href> behavior.
       ============================================================ -->
  <nav class="a2-bottom-nav" aria-label="Mobile navigation">
    {#each mobileNav as item}
      {@const Icon = item.icon}
      {#if item.id === 'more'}
        <button
          type="button"
          class="a2-bottom-item"
          class:active={moreOpen}
          aria-expanded={moreOpen}
          aria-haspopup="dialog"
          aria-label="Open settings"
          bind:this={moreTrigger}
          onclick={openMore}
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
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.5);
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
     MOBILE "MORE" SHEET — REMOVED (MAV-FOCUSED, 2026-10).
     The .a2-more-* CSS rules + the @keyframes a2-fade-in / a2-slide-up
     animations were retired with the sheet. The mobile bottom-nav now
     carries 4 destinations; every other route is reachable through the
     Overview quick-action cards or the System Status metric cards.
     ============================================================ */

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
     MOBILE MORE SHEET (2026-10 admin restructure round 3)
     — left-anchored drawer that surfaces the Settings group on
     mobile. Hidden by default; only rendered when moreOpen=true.
     ============================================================ */
  .a2-more-overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(2px);
    display: block;
  }
  .a2-more-sheet {
    position: fixed;
    bottom: 0; left: 0;
    z-index: 61;
    width: 100%;
    max-width: 420px;
    max-height: 80dvh;
    background: var(--a2-surface-1);
    border-top: 1px solid var(--a2-border-strong);
    border-right: 1px solid var(--a2-border-strong);
    border-top-right-radius: var(--a2-radius-lg);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 -8px 40px rgba(0, 0, 0, 0.45);
  }
  .a2-more-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--a2-space-3);
    padding: var(--a2-space-4);
    padding-top: max(var(--a2-space-4), env(safe-area-inset-top, 0px));
    border-bottom: 1px solid var(--a2-border);
    background: var(--a2-surface-1);
  }
  .a2-more-title {
    margin: 0;
    font-size: var(--a2-text-base);
    font-weight: 700;
    color: var(--a2-text-bright);
  }
  .a2-more-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    background: transparent;
    border: none;
    color: var(--a2-text-muted);
    cursor: pointer;
    border-radius: var(--a2-radius-sm);
    -webkit-tap-highlight-color: transparent;
  }
  .a2-more-close:hover { color: var(--a2-text); background: var(--a2-surface-3); }
  .a2-more-body {
    padding: var(--a2-space-3) var(--a2-space-4) max(var(--a2-space-4), env(safe-area-inset-bottom, 0px));
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
  .a2-more-group-label {
    margin: var(--a2-space-2) 0 var(--a2-space-1);
    font-size: var(--a2-text-2xs);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--a2-text-dim);
  }
  .a2-more-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .a2-more-link {
    display: flex;
    align-items: center;
    gap: var(--a2-space-3);
    padding: var(--a2-space-3);
    min-height: 44px;
    color: var(--a2-text);
    text-decoration: none;
    border-radius: var(--a2-radius-sm);
    font-size: var(--a2-text-sm);
    font-weight: 600;
    -webkit-tap-highlight-color: transparent;
  }
  .a2-more-link:hover { background: var(--a2-surface-3); }
  .a2-more-link:focus-visible {
    outline: 2px solid var(--a2-cyan);
    outline-offset: -2px;
  }
  .a2-more-link.active { color: var(--a2-cyan); background: var(--a2-cyan-soft); }
  .a2-more-link-icon {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    color: var(--a2-text-muted);
  }
  .a2-more-link.active .a2-more-link-icon { color: var(--a2-cyan); }
  .a2-more-link-label { flex: 1 1 auto; }

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
    .a2-workspace { animation: none; }
    .a2-status-dot { animation: none; }
    .a2-sidebar, .a2-topbar, .a2-main { transition: none; }
  }

  /* ============================================================
     FILL MODE (2026-10-16 layout round) — see the `fill` prop comment.
     `.a2-shell .a2-main-fill` (0,2,0) intentionally outranks the
     `.a2-main` base + responsive rules (0,1,0) at every breakpoint:
       - height: 100dvh   → the main region is EXACTLY the viewport
                            (mobile override of `height: auto`);
       - overflow: hidden → the main region is NOT a scroller — the page's
                            internal cards region owns scrolling (this is
                            also why NO descendant may rely on
                            position:sticky against the main region: an
                            `overflow: hidden` ancestor would defeat it);
       - display: flex column → the workspace stretches to the remaining
                            height (100dvh minus padding-top, and minus
                            the mobile bottom-nav padding-bottom), so all
                            heights derive from the REAL header/nav
                            (--a2-topbar-h-safe / --a2-mobile-nav-h-safe,
                            both safe-area aware) — no hard-coded offsets.
     The workspace in fill mode: flex child (fills the main region's
     content box) + flex column itself, with padding-top removed so the
     page's toolbar sits tight under the fixed admin header (the reported
     "large blank gap between the page header and search bar").
     ============================================================ */
  .a2-shell .a2-main-fill { display: flex; flex-direction: column; height: 100dvh; overflow: hidden; }
  .a2-shell .a2-main-fill > .a2-workspace {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding-top: 0;
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
