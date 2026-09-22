<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { page } from '$app/state';
  import { Database, Layers3, ShieldCheck, SlidersHorizontal, ArrowLeft, Activity, Star, Download, Puzzle, PanelLeftClose, PanelLeft, Menu, X, ToggleRight } from 'lucide-svelte';
  import type { Snippet } from 'svelte';

  // ============================================================
  // PHASE G — AdminShell control-room architecture.
  //
  // Desktop (≥1024px):
  //   - Fixed sidebar (position:fixed, 100dvh) on the left.
  //   - Independent main scroll container (height:100dvh, overflow-y:auto).
  //   - Sidebar collapse/expand (244px ↔ 72px), persisted in localStorage
  //     under a SEPARATE key from the public sidebar so the two never
  //     interfere.
  //
  // Mobile (<1024px):
  //   - Fixed mobile header with hamburger.
  //   - Left drawer (backdrop + Escape + focus management) that closes
  //     on route navigation so the overlay never lingers invisibly.
  //
  // Preserved contracts (test-locked):
  //   - `active` prop accepts the 7 admin page ids.
  //   - `links` array literal with id/label/href triplets.
  //   - `aria-label="Admin navigation"` landmark on the desktop <nav>.
  //   - `<slot />` for child content (admin pages still wrap in
  //     <AdminShell active="...">...</AdminShell>).
  //   - `<a class="admin-back" href="/discover">` Back to app link.
  // ============================================================
  let {
    active = 'overview' as 'overview' | 'providers' | 'sources' | 'downloaders' | 'categories' | 'defaults' | 'addons' | 'feature-control',
    children
  }: {
    active?: 'overview' | 'providers' | 'sources' | 'downloaders' | 'categories' | 'defaults' | 'addons' | 'feature-control';
    children: Snippet;
  } = $props();

  const links = [
    { id: 'overview', label: 'Overview', href: '/admin', icon: Database },
    { id: 'providers', label: 'Providers', href: '/admin/providers', icon: ShieldCheck },
    { id: 'sources', label: 'Sources', href: '/admin/sources', icon: SlidersHorizontal },
    { id: 'downloaders', label: 'Downloaders', href: '/admin/downloaders', icon: Download },
    { id: 'defaults', label: 'Defaults', href: '/admin/defaults', icon: Star },
    { id: 'categories', label: 'Categories', href: '/admin/categories', icon: Layers3 },
    { id: 'feature-control', label: 'Feature Control', href: '/admin/feature-control', icon: ToggleRight },
    { id: 'addons', label: 'Stremio Addons', href: '/admin/addons', icon: Puzzle },
  ] as const;

  const STORAGE_KEY = 'mavero:admin-sidebar-collapsed';
  let sidebarCollapsed = $state(false);
  let drawerOpen = $state(false);
  let drawerTrigger: HTMLElement | null = null;
  let drawerEl = $state<HTMLElement | undefined>(undefined);

  // ============================================================
  // Persisted sidebar collapse — restored on mount, updated on toggle.
  // Separate from the public AppShell sidebar key so they never share state.
  // ============================================================
  onMount(() => {
    try {
      sidebarCollapsed = localStorage.getItem(STORAGE_KEY) === 'true';
    } catch { /* SSR / no access */ }
  });

  // Defensive: never leave the body scroll-locked if this shell unmounts
  // while the drawer is open (e.g. navigating away from /admin entirely).
  onDestroy(() => {
    unlockBodyScroll();
  });

  function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
    try { localStorage.setItem(STORAGE_KEY, String(sidebarCollapsed)); } catch { /* no access */ }
  }

  // Sync the CSS variable so all admin layout consumes one source of truth.
  $effect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.style.setProperty(
        '--admin-sidebar-current',
        sidebarCollapsed ? 'var(--admin-sidebar-collapsed)' : 'var(--admin-sidebar-expanded)'
      );
    }
  });

  // ============================================================
  // Mobile drawer — open/close with Escape + backdrop + focus management.
  // Closes on navigation so the overlay never lingers invisibly after the
  // user has moved to another admin route.
  //
  // Body scroll lock: while the drawer is open the underlying page must NOT
  // scroll. We toggle a `data-admin-drawer-open` attribute on <html> which
  // pairs with the CSS rule `html[data-admin-drawer-open] body { overflow: hidden; }`
  // so the underlying admin page is fixed in place while the user interacts
  // with the drawer.
  // ============================================================
  function lockBodyScroll() {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-admin-drawer-open', '');
    }
  }
  function unlockBodyScroll() {
    if (typeof document !== 'undefined') {
      document.documentElement.removeAttribute('data-admin-drawer-open');
    }
  }

  function openDrawer(event: Event) {
    drawerTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    drawerOpen = true;
    lockBodyScroll();
    void tick().then(() => {
      // Focus the close button first so screen readers announce the drawer.
      drawerEl?.querySelector<HTMLElement>('.admin-drawer-close')?.focus();
    });
  }

  function closeDrawer() {
    drawerOpen = false;
    unlockBodyScroll();
    // Restore focus to the trigger so keyboard users don't lose their place.
    drawerTrigger?.focus();
    drawerTrigger = null;
  }

  function handleDrawerKeydown(event: KeyboardEvent) {
    if (!drawerOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDrawer();
      return;
    }
    // Tab trap — focus stays inside the drawer while it's open.
    if (event.key !== 'Tab' || !drawerEl) return;
    const focusable = [...drawerEl.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')];
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
  // Close drawer on route change ONLY — never when the user opens it.
  //
  // ROOT CAUSE of the original "hamburger does not open" bug:
  //   The previous $effect read BOTH `page.url.pathname` AND `drawerOpen`
  //   (the `if (drawerOpen)` check). Svelte 5 re-runs the effect whenever
  //   ANY tracked dependency changes. So when the user tapped the
  //   hamburger → drawerOpen flipped true → the effect re-ran → it saw
  //   drawerOpen === true → it immediately set drawerOpen = false again,
  //   closing the drawer the same frame it opened.
  //
  // FIX: track the PREVIOUS pathname in a closure variable. The effect
  // closes the drawer ONLY when the pathname actually changes (i.e. when
  // the user has navigated to a different admin route). Opening the
  // drawer no longer re-triggers the close path.
  // ============================================================
  let lastPathname = typeof location !== 'undefined' ? location.pathname : '';
  $effect(() => {
    const current = page.url.pathname;
    if (current !== lastPathname) {
      lastPathname = current;
      if (drawerOpen) {
        drawerOpen = false;
        unlockBodyScroll();
        // Focus handled by closeDrawer(); on route change we just hide.
        drawerTrigger = null;
      }
    }
  });
</script>

<div class="admin-shell" class:drawer-open={drawerOpen}>
  <!-- ============================================================
       DESKTOP SIDEBAR (≥1024px) — fixed, 100dvh, owns its own scroll.
       ============================================================ -->
  <aside class="admin-sidebar" aria-label="Admin navigation">
    <a class="admin-brand" href="/discover" aria-label="MAVERO home — back to app">
      <span class="brand-symbol">M</span>
      <span class="brand-copy">
        <span class="brand-name">MAVERO</span>
        <span class="brand-sub">Control room</span>
      </span>
    </a>

    <button
      class="admin-collapse-toggle"
      type="button"
      onclick={toggleSidebar}
      aria-label={sidebarCollapsed ? 'Expand admin sidebar' : 'Collapse admin sidebar'}
      title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
    >
      {#if sidebarCollapsed}<PanelLeft size={16} />{:else}<PanelLeftClose size={16} />{/if}
    </button>

    <nav class="admin-nav">
      <div class="admin-label">Workspace</div>
      {#each links as link}
        {@const Icon = link.icon}
        <a
          class:active={active === link.id}
          class="admin-link"
          href={link.href}
          aria-current={active === link.id ? 'page' : undefined}
          title={sidebarCollapsed ? link.label : undefined}
        >
          <span class="admin-link-icon"><Icon size={17} strokeWidth={active === link.id ? 2.2 : 1.8} /></span>
          {#if !sidebarCollapsed}<span class="admin-link-label">{link.label}</span>{/if}
        </a>
      {/each}
    </nav>

    <div class="admin-sidebar-foot">
      <div class="admin-sidebar-rule"></div>
      <div class="admin-status">
        <span class="admin-status-dot" aria-hidden="true"></span>
        {#if !sidebarCollapsed}<span class="admin-status-label">Live</span>{/if}
      </div>
      <a class="admin-back" href="/discover" title={sidebarCollapsed ? 'Back to Mavero' : undefined}>
        <ArrowLeft size={14} />
        {#if !sidebarCollapsed}<span>Back to app</span>{/if}
      </a>
    </div>
  </aside>

  <!-- ============================================================
       MOBILE HEADER (<1024px) — fixed, hamburger + brand + live status.
       The desktop sidebar is hidden below 1024px; this header takes over.
       ============================================================ -->
  <header class="admin-topbar">
    <button
      class="admin-hamburger"
      type="button"
      onclick={openDrawer}
      aria-label="Open admin navigation"
      aria-expanded={drawerOpen}
      aria-controls="admin-drawer"
    >
      <Menu size={18} />
    </button>
    <a class="admin-topbar-brand" href="/admin" aria-label="MAVERO admin home">
      <span class="brand-symbol">M</span>
      <span class="brand-name">MAVERO</span>
      <span class="brand-sub">Admin</span>
    </a>
    <span class="admin-topbar-status" aria-label="Live status">
      <span class="admin-status-dot" aria-hidden="true"></span>
      <span class="admin-status-label">Live</span>
    </span>
  </header>

  <!-- ============================================================
       MOBILE DRAWER — left-side overlay, closes on backdrop click /
       Escape / route change.
       ============================================================ -->
  {#if drawerOpen}
    <div class="admin-drawer-overlay" onclick={closeDrawer} aria-hidden="true"></div>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      id="admin-drawer"
      class="admin-drawer"
      bind:this={drawerEl}
      role="dialog"
      aria-modal="true"
      aria-label="Admin navigation"
      tabindex="-1"
      onkeydown={handleDrawerKeydown}
    >
      <div class="admin-drawer-head">
        <a class="admin-brand" href="/admin" aria-label="MAVERO admin home">
          <span class="brand-symbol">M</span>
          <span class="brand-copy">
            <span class="brand-name">MAVERO</span>
            <span class="brand-sub">Admin</span>
          </span>
        </a>
        <button class="admin-drawer-close" type="button" onclick={closeDrawer} aria-label="Close admin navigation">
          <X size={16} />
        </button>
      </div>
      <nav class="admin-drawer-nav" aria-label="Admin navigation">
        <div class="admin-label">Workspace</div>
        {#each links as link}
          {@const Icon = link.icon}
          <a
            class:active={active === link.id}
            class="admin-link"
            href={link.href}
            aria-current={active === link.id ? 'page' : undefined}
            onclick={closeDrawer}
          >
            <span class="admin-link-icon"><Icon size={17} strokeWidth={active === link.id ? 2.2 : 1.8} /></span>
            <span class="admin-link-label">{link.label}</span>
          </a>
        {/each}
      </nav>
      <div class="admin-drawer-foot">
        <div class="admin-sidebar-rule"></div>
        <a class="admin-back" href="/discover" onclick={closeDrawer}>
          <ArrowLeft size={14} />
          <span>Back to Mavero</span>
        </a>
      </div>
    </div>
  {/if}

  <!-- ============================================================
       MAIN CONTENT — independent scroll container (desktop) / fluid
       flow with top padding for the mobile topbar (mobile).
       ============================================================ -->
  <main class="admin-main">
    <div class="admin-content">
      {@render children()}
    </div>
  </main>
</div>

<style>
  .admin-shell {
    display: block;
    background: var(--color-bg);
    overflow-x: hidden;
  }

  /* ============================================================
     DESKTOP SIDEBAR
     ============================================================ */
  .admin-sidebar {
    position: fixed;
    top: 0; left: 0; bottom: 0;
    width: var(--admin-sidebar-current);
    height: 100dvh;
    z-index: 50;
    display: flex;
    flex-direction: column;
    padding: 20px 12px 16px;
    background: var(--color-surface);
    border-right: 1px solid var(--color-border);
    overflow-y: auto;
    transition: width var(--motion-normal) var(--ease-out);
  }
  .admin-sidebar::-webkit-scrollbar { width: 4px; }
  .admin-sidebar::-webkit-scrollbar-thumb { background: var(--color-border-strong); border-radius: 4px; }

  .admin-brand {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    padding: 0 6px 4px;
    color: var(--color-text);
    text-decoration: none;
  }
  .brand-symbol {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 9px;
    color: #050708;
    background: var(--color-primary);
    border: 1px solid var(--color-primary-border);
    box-shadow: var(--glow-primary);
    font-size: .95rem;
    font-weight: 900;
    flex: 0 0 auto;
  }
  .brand-copy {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .brand-name {
    font-size: .92rem;
    font-weight: 900;
    letter-spacing: .04em;
    color: var(--color-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .brand-sub {
    color: var(--color-text-deep);
    font-size: .48rem;
    font-weight: 600;
    letter-spacing: .12em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .admin-collapse-toggle {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    margin: 8px 0 0 6px;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--color-text-muted);
    background: transparent;
    cursor: pointer;
    transition: color var(--motion-fast) var(--ease-out),
                background var(--motion-fast) var(--ease-out),
                border-color var(--motion-fast) var(--ease-out);
  }
  .admin-collapse-toggle:hover {
    color: var(--color-primary);
    background: var(--color-primary-soft);
    border-color: var(--color-border);
  }
  .admin-collapse-toggle:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 2px;
  }

  .admin-nav {
    display: grid;
    gap: 2px;
    margin-top: 28px;
  }
  .admin-label {
    margin: 0 12px 9px;
    color: var(--color-text-deep);
    font-size: .53rem;
    font-weight: 800;
    letter-spacing: .14em;
    text-transform: uppercase;
  }
  .admin-link {
    display: flex;
    align-items: center;
    gap: 13px;
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid transparent;
    border-radius: 10px;
    color: var(--color-text-muted);
    font-size: .82rem;
    font-weight: 600;
    text-decoration: none;
    transition: color var(--motion-fast) var(--ease-out),
                background var(--motion-fast) var(--ease-out),
                border-color var(--motion-fast) var(--ease-out),
                transform var(--motion-fast) var(--ease-out);
  }
  .admin-link:hover {
    color: var(--color-primary);
    background: var(--color-primary-soft);
    transform: translateX(2px);
  }
  .admin-link:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 2px;
  }
  .admin-link.active {
    color: var(--color-primary);
    font-weight: 700;
    border-color: var(--color-primary-border);
    background: var(--color-primary-soft);
    box-shadow: var(--glow-primary);
  }
  .admin-link-icon {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
  }
  .admin-link-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .admin-sidebar-foot {
    display: grid;
    gap: 12px;
    margin-top: auto;
  }
  .admin-sidebar-rule {
    height: 1px;
    background: var(--color-border);
  }
  .admin-status {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 6px;
    color: var(--color-text-deep);
    font-size: .55rem;
    font-weight: 700;
    letter-spacing: .1em;
    text-transform: uppercase;
  }
  .admin-status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-primary);
    box-shadow: 0 0 6px var(--color-primary);
  }
  .admin-status-label { color: var(--color-text-muted); }
  .admin-back {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 6px;
    color: var(--color-text-muted);
    font-size: .68rem;
    font-weight: 600;
    text-decoration: none;
    min-height: 36px;
    transition: color var(--motion-fast) var(--ease-out);
  }
  .admin-back:hover { color: var(--color-primary); }
  .admin-back:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; border-radius: 4px; }

  /* Collapsed state — labels are conditionally rendered (see template),
     so links naturally center when only the icon is present. The
     `.admin-link-icon` keeps its fixed footprint so all links stay
     aligned whether expanded or collapsed. */

  /* ============================================================
     MAIN CONTENT — independent vertical scroll, never inherits the
     sidebar's scroll. Content area is bounded by a responsive max-width
     appropriate for a control-room interface.
     ============================================================ */
  .admin-main {
    margin-left: var(--admin-sidebar-current);
    min-height: 100dvh;
    overflow-y: auto;
    overflow-x: hidden;
    transition: margin-left var(--motion-normal) var(--ease-out);
  }
  .admin-content {
    width: min(1400px, calc(100% - clamp(32px, 5vw, 80px)));
    margin-inline: auto;
    padding-top: clamp(24px, 4vw, 48px);
    padding-bottom: clamp(48px, 6vw, 96px);
  }
  /* Mobile (<1024px) — tighten the top + bottom padding so the first card
     appears without scrolling. The topbar already offsets the page via
     .admin-main { padding-top: var(--admin-topbar-h-safe) }, so the content
     itself only needs a small breathing gap below the topbar. */
  @media (max-width: 1023px) {
    .admin-content {
      width: min(100% - 28px, 1400px);
      padding-top: 14px;
      padding-bottom: 80px;
    }
  }
  /* AdminPageHeader renders its own scoped h1 (class="admin-title"), so the
     global h1 rule below is intentionally minimal — it only provides a
     fallback for admin pages that render a bare <h1> without the header
     component. The AdminPageHeader's scoped rules take precedence for
     pages that use it. */
  .admin-content :global(h1:not(.admin-title)) {
    margin: 10px 0 0;
    color: var(--color-text);
    font-size: clamp(1.7rem, 3.2vw, 2.4rem);
    font-weight: 900;
    letter-spacing: -.02em;
    line-height: 1.1;
  }
  .admin-content :global(h1:not(.admin-title) em) { color: var(--color-primary); font-style: normal; }
  .admin-content :global(h2) {
    margin: 0;
    color: var(--color-text);
    font-size: 1.15rem;
    font-weight: 800;
    letter-spacing: -.01em;
  }

  /* ============================================================
     MOBILE HEADER (<1024px)
     ============================================================ */
  .admin-topbar {
    display: none;
  }

  /* ============================================================
     RESPONSIVE BREAKPOINT — desktop sidebar below 1024px.
     ============================================================ */
  @media (max-width: 1023px) {
    .admin-sidebar { display: none; }
    .admin-main {
      margin-left: 0;
      min-height: auto;
      height: auto;
      overflow-y: visible;
      padding-top: var(--admin-topbar-h-safe);
    }
    .admin-topbar {
      position: fixed;
      top: 0; left: 0; right: 0;
      display: flex;
      align-items: center;
      gap: 12px;
      height: var(--admin-topbar-h-safe);
      padding: env(safe-area-inset-top, 0px) clamp(14px, 4vw, 20px) 0;
      border-bottom: 1px solid var(--color-border);
      background: rgba(5, 7, 8, .9);
      backdrop-filter: blur(20px);
      z-index: 50;
    }
    .admin-hamburger {
      display: grid;
      place-items: center;
      width: 40px;
      height: 40px;
      border: 1px solid var(--color-border);
      border-radius: 10px;
      color: var(--color-text);
      background: var(--color-surface);
      cursor: pointer;
      transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
    }
    .admin-hamburger:hover { background: var(--color-primary-soft); border-color: var(--color-primary-border); }
    .admin-hamburger:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
    .admin-topbar-brand {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      color: var(--color-text);
      text-decoration: none;
      flex: 1;
      min-width: 0;
    }
    .admin-topbar-brand .brand-symbol { width: 26px; height: 26px; font-size: .85rem; }
    .admin-topbar-brand .brand-name { font-size: .86rem; }
    .admin-topbar-brand .brand-sub {
      font-size: .42rem;
      padding: 2px 6px;
      border: 1px solid var(--color-border);
      border-radius: 4px;
    }
    .admin-topbar-status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--color-text-muted);
      font-size: .54rem;
      font-weight: 700;
      letter-spacing: .1em;
      text-transform: uppercase;
    }
  }

  /* ============================================================
     MOBILE DRAWER (<1024px)
     ============================================================ */
  .admin-drawer-overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgba(5, 7, 8, .7);
    backdrop-filter: blur(4px);
    animation: drawer-fade-in var(--motion-fast) var(--ease-out);
  }
  .admin-drawer {
    position: fixed;
    top: 0; left: 0; bottom: 0;
    width: min(280px, 84vw);
    height: 100dvh;
    z-index: 61;
    display: flex;
    flex-direction: column;
    padding: 16px 12px 18px;
    background: var(--color-surface);
    border-right: 1px solid var(--color-border);
    box-shadow: var(--shadow-lg);
    overflow-y: auto;
    animation: drawer-slide-in var(--motion-normal) var(--ease-out);
  }
  .admin-drawer-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 0 6px 14px;
    border-bottom: 1px solid var(--color-border);
    margin-bottom: 14px;
  }
  .admin-drawer-head .admin-brand { padding: 0; }
  .admin-drawer-close {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border: 1px solid var(--color-border-strong);
    border-radius: 10px;
    color: var(--color-text-muted);
    background: transparent;
    cursor: pointer;
    transition: color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
  }
  .admin-drawer-close:hover { color: var(--color-text); border-color: var(--color-primary-border); }
  .admin-drawer-close:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .admin-drawer-nav {
    display: grid;
    gap: 2px;
    flex: 1;
  }
  .admin-drawer-foot {
    display: grid;
    gap: 10px;
    margin-top: 18px;
  }
  .admin-drawer-foot .admin-back { padding: 8px 6px; }

  @keyframes drawer-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes drawer-slide-in {
    from { transform: translateX(-100%); }
    to { transform: translateX(0); }
  }

  /* Large desktop / TV — progressive content max-width strategy.
     At 1920px: 1700px content (measured: 115px free space — appropriate).
     At 2560px: 1700px still works (measured: 616px free — acceptable, ~12% per side).
     At 3840px: 1700px is too narrow (measured: 1896px free — 53% empty per side).
     Fix: at 2560px+ allow up to 2100px; at 3840px+ allow up to 2400px.
     This keeps content bounded so text lines don't become excessively
     wide, while preventing the 4K "narrow column in a sea of space" look. */
  @media (min-width: 1920px) {
    .admin-content {
      width: min(1700px, calc(100% - clamp(60px, 6vw, 120px)));
    }
  }
  @media (min-width: 2560px) {
    .admin-content {
      width: min(2100px, calc(100% - clamp(80px, 5vw, 160px)));
    }
  }
  @media (min-width: 3840px) {
    .admin-content {
      width: min(2400px, calc(100% - clamp(100px, 4vw, 200px)));
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .admin-sidebar, .admin-main { transition: none; }
    .admin-drawer, .admin-drawer-overlay { animation: none; }
  }
</style>
