<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { Compass, Search, UserRound, Clapperboard, Film, Sparkles, Tv, Radio, Bookmark, CalendarClock, Settings } from 'lucide-svelte';
  import AccountSheet from '$components/AccountSheet.svelte';
  import { haptic } from '$lib/client/haptics';
  // TV-UX pass (widget build only): the sidebar AUTO-EXPANDS when TV focus
  // enters it and AUTO-COLLAPSES back to the icon rail when focus returns to
  // content. The spatial focus manager ($lib/tv/focus) dispatches the
  // 'mavero:tv-sidebar' CustomEvent; the widget boots COLLAPSED so content
  // gets the full width. Compile-time no-op on production (the event is
  // never dispatched and the stored preference applies as before).
  import { IS_WGT_BUILD } from '$lib/shared/build-mode';

  let { children, currentPath = '/', user = null, isAuthenticated = false, isAdmin = false, appConfig = null }: { children: Snippet; currentPath?: string; user?: { id: string; email?: string | null; displayName?: string | null; avatarUrl?: string | null } | null; isAuthenticated?: boolean; isAdmin?: boolean; appConfig?: { telegramUrl: string | null; discordUrl: string | null } | null } = $props();
  let shell: HTMLElement;

  // R-2 — the Live TV availability state. Fetched ONCE per AppShell mount
  // (a full page load — SvelteKit's SPA navigations don't remount the
  // layout, so the state survives in-app navigation). When `available` is
  // false the Live TV link is hidden from BOTH the desktop sidebar and the
  // mobile bottom nav. Fail-open: a fetch failure keeps the link visible
  // (the /live-tv SSR guard is the authoritative gate; the navbar hide is
  // defense-in-depth — never the sole enforcement).
  let liveTvAvailable = $state(true);
  // Admin nav toggle (from /api/livetv/availability). FALSE hides Live TV from
  // guests/standard users; admins ALWAYS see it (isAdmin prop).
  let livetvNavVisible = $state(true);
  $effect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    void (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        try {
          const response = await fetch('/api/livetv/availability', { signal: controller.signal, headers: { accept: 'application/json' } });
          if (response.ok) {
            const body: unknown = await response.json();
            if (body && typeof body === 'object' && 'available' in body && typeof (body as { available: unknown }).available === 'boolean') {
              if (!cancelled) liveTvAvailable = (body as { available: boolean }).available;
            }
            if (body && typeof body === 'object' && 'navVisible' in body && typeof (body as { navVisible: unknown }).navVisible === 'boolean') {
              if (!cancelled) livetvNavVisible = (body as { navVisible: boolean }).navVisible;
            }
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // Fail-open: keep the link visible (the route guard is the authority).
      }
    })();
    return () => { cancelled = true; };
  });

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
  // R-2: the Live TV entry is hidden when no eligible public source exists
  // (the navbar hide is defense-in-depth on top of the /live-tv SSR guard
  // — the route/API enforcement is the authority).
  //
  // Phase 2 — responsive compositions:
  //   MOBILE + TABLET (≤1024px): floating pill bottom nav (touch
  //   composition) + topbar with the Search control on the right.
  //   DESKTOP (≥1025px): proper vertical sidebar (Browse hierarchy,
  //   collapse behavior) + the Search AND Account controls INSIDE the
  //   sidebar (2026-11 desktop-UX fix — see the sidebar markup).
  // The pill and the sidebar are intentionally DIFFERENT compositions —
  // the mobile pill is never copied onto desktop and vice versa.
  //
  // 2026-11 DESKTOP-UX FIX (reported: "Account Chip missing on desktop;
  // Search floating in the top-right corner"): the former desktop
  // composition rendered ONLY a fixed top-right glass chip (which was —
  // despite its misleading `header-account` class — a SEARCH link) and had
  // NO desktop Account control at all. The floating chip is REMOVED; the
  // sidebar now carries both controls like any standard desktop app:
  //   * Search  — a sidebar-link in the nav list (real <a>, active state,
  //     collapsed-mode icon rail);
  //   * Account — a sidebar chip above the bottom rule that opens the SAME
  //     compact AccountSheet the mobile pill uses.
  // BREAKPOINT CONTRACT (the user-visible ask was "@media (min-width:
  // 1024px) so this ONLY applies to Desktop"): the additions live INSIDE
  // the .app-sidebar container, which the ≤1024px block sets to display:
  // none — so they render exactly on the desktop composition (≥1025px,
  // this app's established desktop boundary) and can never touch the
  // mobile/tablet topbar + bottom-pill layout. Keeping 1025px avoids a
  // 1px-wide viewport (exactly 1024px) where both media queries would
  // otherwise match and double-render the controls.
  const primaryLinks = $derived([
    { label: 'Discover', href: '/discover', key: '/discover', icon: Compass },
    { label: 'Movies', href: '/movies', key: '/movies', icon: Film },
    { label: 'TV Shows', href: '/tv-shows', key: '/tv-shows', icon: Tv },
    { label: 'Anime', href: '/anime', key: '/anime', icon: Sparkles },
    ...((liveTvAvailable && (isAdmin || livetvNavVisible)) ? [{ label: 'Live TV', href: '/live-tv', key: '/live-tv', icon: Radio }] : [])
  ]);

  const isActive = (key: string) => currentPath === key || currentPath.startsWith(`${key}/`);

  // Phase 3 — the compact Account sheet, opened from the Account control:
  // the bottom-pill Account entry (≤1024px). The former sidebar Account chip
  // was replaced by the sidebar USER CHIP (an /account link) in the 2026-11
  // account-IA pass — the sheet is now a touch-composition surface; the
  // desktop account surface is the chip + the Upcoming / My List / Settings
  // nav links.
  let accountSheetOpen = $state(false);
  const isAccountSurface = $derived(isActive('/settings'));
  // 2026-11 pass-4 fix (bug 9 — real web bug): the sheet anchors to the
  // control that opened it instead of parking at a detached top-right
  // corner. The pill trigger is bound; when it is not visible (the hidden
  // desktop composition reports offsetParent null) the sheet centres.
  let pillAccountEl: HTMLButtonElement | undefined = $state();
  let accountAnchorEl = $state<HTMLElement | null>(null);

  function openAccountSheet() {
    if (accountSheetOpen) return;
    haptic('light');
    try {
      accountAnchorEl = pillAccountEl && pillAccountEl.offsetParent ? pillAccountEl : null;
    } catch {
      accountAnchorEl = null;
    }
    accountSheetOpen = true;
  }

  function closeAccountSheet() {
    accountSheetOpen = false;
  }

  // Sidebar collapse — persisted in localStorage
  let sidebarCollapsed = $state(false);
  const STORAGE_KEY = 'mavero:sidebar-collapsed';

  onMount(async () => {
    // Restore sidebar state. TV: boot COLLAPSED regardless of the stored
    // value — the auto-expand/collapse contract owns the state from here.
    if (IS_WGT_BUILD) {
      sidebarCollapsed = true;
    } else {
      try {
        sidebarCollapsed = localStorage.getItem(STORAGE_KEY) === 'true';
      } catch { /* SSR / no access */ }
    }

    const { gsap } = await import('gsap');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || !shell) return;
    gsap.fromTo(shell, { opacity: 0 }, { opacity: 1, duration: 0.4, ease: 'power2.out' });
  });

  // TV auto-expand/collapse: the spatial focus manager decides when focus
  // sits in the sidebar (expand) or in the content (icon rail).
  $effect(() => {
    if (!IS_WGT_BUILD || typeof window === 'undefined') return;
    const handler = (event: Event) => {
      try {
        const detail = (event as CustomEvent<{ collapsed?: boolean }>).detail;
        if (detail && typeof detail.collapsed === 'boolean') sidebarCollapsed = detail.collapsed;
      } catch {
        /* cosmetic */
      }
    };
    window.addEventListener('mavero:tv-sidebar', handler);
    return () => window.removeEventListener('mavero:tv-sidebar', handler);
  });

  function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
    // TV: the auto-expand/collapse contract owns the state — never persist
    // a manual toggle over it (the next focus move would override anyway).
    if (!IS_WGT_BUILD) {
      try { localStorage.setItem(STORAGE_KEY, String(sidebarCollapsed)); } catch { /* no access */ }
    }
  }

  // 2026-11 account-IA pass ("ACCOUNT OPTIONS INTO THE SIDEBAR"): the three
  // account OPTIONS (Upcoming / My List / Settings) render on EVERY build as
  // regular .sidebar-link entries below Search (the WGT-only wrapper is
  // gone), and the sidebar bottom carries the social row + the tagline + a
  // USER CHIP (avatar initials + name + secondary line, linking to
  // /account). The former desktop Account chip + its AccountSheet trigger
  // are REMOVED from the sidebar — the sheet stays reachable from the mobile
  // pill below 1025px.
  const accountDisplayName = $derived(user?.displayName ?? (user?.email ? user.email.split('@')[0] : 'Guest'));
  // Same initials model as AccountSheet's identity block — first letters of
  // the first two words, else the first two characters.
  const accountInitials = $derived((() => {
    const name = accountDisplayName;
    if (!name) return '·';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  })());
  // The user chip's secondary line: "Guest" when signed out, the email
  // otherwise (name fallback when the account carries no email).
  const accountSecondary = $derived(!isAuthenticated ? 'Guest' : (user?.email ?? accountDisplayName));
  // Social row inputs — the SAME appConfig URLs AccountSheet forwards (no
  // new constants); the row renders nothing when both are null.
  const telegramUrl = $derived(appConfig?.telegramUrl ?? null);
  const discordUrl = $derived(appConfig?.discordUrl ?? null);

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

<div class="page-shell" class:sidebar-collapsed={sidebarCollapsed} bind:this={shell}>
  <!-- Desktop sidebar (fixed, 1025px+) -->
  <aside class="app-sidebar" aria-label="Primary navigation">
    <!-- 2026-11 account-IA pass ("REPLACE THE COLLAPSE TOGGLE WITH THE BRAND"): the standalone
         .sidebar-toggle button is GONE on every build. On the WEB build the brand
         lockup IS the toggle — a <button> that flips the sidebar (collapsed →
         expanded → collapsed, persisted through the existing toggleSidebar()
         localStorage path) and navigates NOWHERE (Discover is the first nav
         link). On the WGT/TV build the lockup stays a PLAIN non-interactive
         element — the focus manager's auto-expand/collapse contract owns the
         sidebar state there, so the brand neither toggles nor navigates. -->
    {#if IS_WGT_BUILD}
      <div class="brand-lockup">
        <span class="brand-symbol"><Clapperboard size={17} strokeWidth={2.1} /></span>
        {#if !sidebarCollapsed}<span class="brand-word">MAVERO</span>{/if}
      </div>
    {:else}
      <button
        type="button"
        class="brand-lockup"
        onclick={toggleSidebar}
        aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!sidebarCollapsed}
        title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <span class="brand-symbol"><Clapperboard size={17} strokeWidth={2.1} /></span>
        {#if !sidebarCollapsed}<span class="brand-word">MAVERO</span>{/if}
      </button>
    {/if}
    <nav class="sidebar-nav">
      {#if !sidebarCollapsed}<div class="sidebar-section-label" aria-hidden="true">Browse</div>{/if}
      {#each primaryLinks as link}
        {@const Icon = link.icon}
        <a class:active={isActive(link.key)} class="sidebar-link" href={link.href} aria-current={isActive(link.key) ? 'page' : undefined} title={sidebarCollapsed ? link.label : undefined}>
          <span class="sidebar-icon"><Icon size={19} strokeWidth={isActive(link.key) ? 2.3 : 1.8} /></span>
          {#if !sidebarCollapsed}<span class="sidebar-label">{link.label}</span>{/if}
        </a>
      {/each}
      <!-- 2026-11 desktop-UX fix: Search belongs IN the sidebar (standard
           desktop IA) — the former fixed top-right floating chip is removed
           (see the removal note above). Same link styling + active state as
           the Browse entries; collapses to the icon rail like them. -->
      <a
        class:active={isActive('/search')}
        class="sidebar-link"
        href="/search"
        aria-current={isActive('/search') ? 'page' : undefined}
        title={sidebarCollapsed ? 'Search' : undefined}
      >
        <span class="sidebar-icon"><Search size={19} strokeWidth={isActive('/search') ? 2.3 : 1.8} /></span>
        {#if !sidebarCollapsed}<span class="sidebar-label">Search</span>{/if}
      </a>
      <!-- 2026-11 account-IA pass ("ACCOUNT OPTIONS BECOME SIDEBAR LINKS"): the
           three account OPTIONS (Upcoming / My List / Settings) render on
           EVERY build directly BELOW Search as regular .sidebar-link items
           (same icon size, active state, collapsed title) — the WGT-only
           wrapper is gone. aria-current="page" stays on the active one. -->
      <a class:active={isActive('/upcoming')} class="sidebar-link" href="/upcoming" aria-current={isActive('/upcoming') ? 'page' : undefined} title={sidebarCollapsed ? 'Upcoming' : undefined}>
        <span class="sidebar-icon"><CalendarClock size={19} strokeWidth={isActive('/upcoming') ? 2.3 : 1.8} /></span>
        {#if !sidebarCollapsed}<span class="sidebar-label">Upcoming</span>{/if}
      </a>
      <a class:active={isActive('/my-list')} class="sidebar-link" href="/my-list" aria-current={isActive('/my-list') ? 'page' : undefined} title={sidebarCollapsed ? 'My List' : undefined}>
        <span class="sidebar-icon"><Bookmark size={19} strokeWidth={isActive('/my-list') ? 2.3 : 1.8} /></span>
        {#if !sidebarCollapsed}<span class="sidebar-label">My List</span>{/if}
      </a>
      <a class:active={isActive('/settings')} class="sidebar-link" href="/settings" aria-current={isActive('/settings') ? 'page' : undefined} title={sidebarCollapsed ? 'Settings' : undefined}>
        <span class="sidebar-icon"><Settings size={19} strokeWidth={isActive('/settings') ? 2.3 : 1.8} /></span>
        {#if !sidebarCollapsed}<span class="sidebar-label">Settings</span>{/if}
      </a>
    </nav>
    <!-- 2026-11 account-IA pass ("SIDEBAR BOTTOM: SOCIAL ROW + USER CHIP"):
         the former bottom area (desktop Account chip / WGT name chip + rule +
         tagline) is replaced on EVERY build by, top to bottom:
           a) SOCIAL ROW — Telegram + Discord icon squares from the appConfig
              URLs AccountSheet already consumes (renders nothing when both
              are null);
           b) TAGLINE — expanded state only;
           c) USER CHIP — the LAST element: a 36px avatar (initials, or the
              user's avatarUrl when present) + the display name and a
              secondary line, rendered as an /account link so the account page
              stays reachable on desktop (the sheet's desktop chip is gone —
              the pill keeps it below 1025px). -->
    <div class="sidebar-bottom">
      {#if telegramUrl || discordUrl}
        <div class="sidebar-social">
          {#if telegramUrl}
            <a class="social-btn" href={telegramUrl} target="_blank" rel="noreferrer" aria-label="Join us on Telegram" title="Join us on Telegram">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>
            </a>
          {/if}
          {#if discordUrl}
            <a class="social-btn" href={discordUrl} target="_blank" rel="noreferrer" aria-label="Join our Discord" title="Join our Discord">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3c-.2.4-.4.9-.6 1.3a18.3 18.3 0 0 0-5.5 0C9.1 3.9 8.9 3.4 8.7 3a19.7 19.7 0 0 0-4.9 1.5C.6 9.1-.2 13.7.2 18.3A19.9 19.9 0 0 0 6.3 21c.4-.6.8-1.2 1.1-1.9-.6-.2-1.2-.5-1.7-.9l.4-.3a14.2 14.2 0 0 0 12.2 0l.4.3c-.5.4-1.1.7-1.7.9.3.7.7 1.3 1.1 1.9a19.8 19.8 0 0 0 6.1-2.7c.5-5.3-.8-9.8-2.5-13.9zM8.5 15.3c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4zm7 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4z"/></svg>
            </a>
          {/if}
        </div>
      {/if}
      {#if !sidebarCollapsed}<span class="sidebar-caption">Your screen. Your story.</span>{/if}
      <a class="sidebar-user" href="/account" aria-label={`Account: ${accountDisplayName}`} title={accountDisplayName}>
        <span class="user-avatar">
          {#if user?.avatarUrl}
            <img class="user-avatar-img" src={user.avatarUrl} alt="" loading="lazy" />
          {:else}
            {accountInitials}
          {/if}
        </span>
        {#if !sidebarCollapsed}
          <span class="user-meta">
            <span class="user-name">{accountDisplayName}</span>
            <span class="user-sub">{accountSecondary}</span>
          </span>
        {/if}
      </a>
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
      <a
        class:active={isActive('/search')}
        class="topbar-account"
        href="/search"
        aria-label="Search"
        aria-current={isActive('/search') ? 'page' : undefined}
      >
        <Search size={20} strokeWidth={isActive('/search') ? 2.3 : 1.8} />
      </a>
    </header>

    <main>{@render children()}</main>
  </div>

  <!-- Compact Account sheet (Phase 3 + LT-1): identity + Upcoming + My
       List + Settings. Anchored above the Account control that opened it
       (2026-11 pass-4 fix — bug 9). -->
  <AccountSheet open={accountSheetOpen} onClose={closeAccountSheet} {user} {isAuthenticated} telegramUrl={telegramUrl} discordUrl={discordUrl} anchorEl={accountAnchorEl} />

  <!-- Mobile + tablet bottom nav (touch composition, ≤1024px).
       MAV-21 Workstream D — rendered UNCONDITIONALLY on every shell
       route: global navigation must never be suppressed by a page
       (the former /settings opt-out is removed along with its
       page-specific Back button). -->
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
        <button
          type="button"
          bind:this={pillAccountEl}
          class:active={isAccountSurface}
          class="nav-account"
          aria-haspopup="dialog"
          aria-expanded={accountSheetOpen}
          aria-label="Account"
          onclick={openAccountSheet}
        >
          <span class="nav-icon"><UserRound size={20} strokeWidth={isAccountSurface ? 2.3 : 1.8} /></span>
          <span class="nav-label">Account</span>
        </button>
      </div>
    </nav>
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
  /* 2026-11 account-IA pass — the WEB brand lockup IS the collapse toggle
     (the standalone .sidebar-toggle is deleted on every build; WGT keeps a
     plain non-interactive lockup above). Button reset + the SAME hover
     surface / focus ring the old toggle used (transparent border keeps the
     box metrics stable so the hover paint never shifts the layout). */
  button.brand-lockup {
    border: 1px solid transparent; border-radius: 10px;
    background: transparent; cursor: pointer; font: inherit; text-align: left;
    transition: color var(--motion-fast), background var(--motion-fast), border-color var(--motion-fast);
  }
  button.brand-lockup:hover {
    color: var(--color-primary); background: var(--color-primary-soft);
    border-color: var(--color-border);
  }
  button.brand-lockup:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
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
  /* 2026-11 account-IA pass — the sidebar bottom. The desktop Account chip
     is REMOVED (the sheet stays a touch-composition surface); the bottom
     now reads: social row → tagline → USER CHIP (an /account link). */
  .sidebar-social { display: flex; align-items: center; gap: 8px; }
  .social-btn {
    display: grid; place-items: center;
    width: 32px; height: 32px; border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, .12);
    color: var(--color-text-muted); background: transparent;
    transition: color var(--motion-fast), background var(--motion-fast), border-color var(--motion-fast);
  }
  .social-btn:hover { color: var(--color-text); background: var(--color-primary-soft); border-color: var(--color-border-strong); }
  .social-btn:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .sidebar-user {
    display: flex; align-items: center; gap: 11px; min-height: 44px; padding: 3px 8px;
    border: 1px solid transparent; border-radius: 12px;
    color: var(--color-text); text-decoration: none;
    transition: background var(--motion-fast), border-color var(--motion-fast);
  }
  .sidebar-user:hover { background: var(--color-primary-soft); border-color: var(--color-border); }
  .sidebar-user:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .user-avatar {
    display: grid; place-items: center; flex-shrink: 0;
    width: 36px; height: 36px; border-radius: 50%;
    color: var(--color-primary); background: var(--color-primary-soft);
    border: 1px solid var(--color-primary-border);
    font-size: .72rem; font-weight: 800; letter-spacing: .02em;
    overflow: hidden;
  }
  .user-avatar-img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .user-meta { display: grid; gap: 1px; min-width: 0; }
  .user-name {
    font-size: .78rem; font-weight: 700; color: var(--color-text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .user-sub {
    font-size: .62rem; font-weight: 500; color: var(--color-text-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sidebar-bottom { display: grid; gap: 14px; margin-top: auto; }
  .sidebar-caption {
    padding: 0 12px; max-width: 150px;
    color: var(--color-text-deep); font-size: .68rem; font-weight: 500; line-height: 1.4;
  }

  /* Collapsed sidebar — icon only. TV-UX pass 5 (test pass 5, bug 5 —
     "Collapsed-state icons are not on one vertical axis"): the previous
     `:has()` probe (`.page-shell:has(.app-sidebar .sidebar-link:not(:has(.sidebar-label)))`)
     does NOT work on the TV engine (Chromium < 88 has no `:has()` support),
     so the collapsed icons never centered. The page-shell now carries an
     explicit `.sidebar-collapsed` class (bound to the sidebarCollapsed
     state) — engine-proof, identical behavior on every browser. Every
     icon (search, nav, account options, footer) centers on the same
     vertical axis; the tagline is markup-hidden; the social buttons and
     the avatar circle center on the rail axis while the user chip keeps
     its 44px hit area. */
  .sidebar-collapsed .sidebar-link {
    justify-content: center; padding: 0;
  }
  .sidebar-collapsed .sidebar-social {
    justify-content: center;
  }
  .sidebar-collapsed .sidebar-user {
    justify-content: center; padding: 3px 0;
  }

  /* ---- Mobile topbar (≤1024px) ---- */
  .topbar { display: none; }
  .mobile-brand { display: none; }
  .topbar-account { display: none; }

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
       neither the sidebar nor the pill was visible).
       LT-19 — centered WITHOUT a transform: a transformed fixed layer is
       the documented Chrome-Android class that fails to re-anchor during
       URL-bar show/hide scroll transitions (the pill drifted ~20-25% into
       the viewport bottom edge and recovered on direction change). Edge
       anchoring (left: 0; right: 0) + auto margins centers pixel-identically
       with zero transforms — the same pattern the Admin shell's bottom nav
       uses. */
    .mobile-nav {
      display: block;
      position: fixed; left: 0; right: 0;
      bottom: calc(14px + env(safe-area-inset-bottom, 0px));
      z-index: 50;
      width: min(calc(100% - 24px), 480px);
      margin-inline: auto;
    }
    .mobile-nav-inner {
      display: flex;
      align-items: center; gap: 2px; padding: 6px;
      border: 1px solid var(--color-border-strong); border-radius: 999px;
      background: rgba(8, 11, 13, .85); backdrop-filter: blur(20px);
      box-shadow: 0 12px 32px rgba(0, 0, 0, .55), 0 0 0 1px rgba(255, 255, 255, .03);
    }
    .mobile-nav a {
      display: grid; place-items: center; gap: 2px; flex: 1 1 0;
      min-width: 0; min-height: 44px; padding: 6px 2px;
      border-radius: 999px;
      color: var(--color-text-muted);
      font-size: .58rem; font-weight: 700; letter-spacing: .02em;
      text-decoration: none;
      transition: color 180ms ease, background 180ms ease;
    }
    .mobile-nav button.nav-account {
      display: grid; place-items: center; gap: 2px; flex: 1 1 0;
      min-width: 0; min-height: 44px; padding: 6px 2px;
      border: 0; background: transparent; border-radius: 999px; cursor: pointer;
      color: var(--color-text-muted);
      font-size: .58rem; font-weight: 700; letter-spacing: .02em;
      transition: color 180ms ease, background 180ms ease;
    }
    .mobile-nav button.nav-account.active { color: var(--color-text); background: var(--color-surface-raised); }
    .mobile-nav .nav-icon { display: grid; place-items: center; }
    /* A11y #1 (Lighthouse color-contrast): the nav-label was using
       --color-text-deep (#60686c, ~3.1:1 contrast) + opacity:.9 (even
       lower). Bumped to --color-text-muted (#9da3a8, ~5.8:1) and removed
       the opacity reduction so the label passes WCAG AA (≥4.5:1) on the
       rgba(8,11,13,.85) backdrop-blur surface. */
    .mobile-nav .nav-label { white-space: nowrap; }
    .mobile-nav a:hover { color: var(--color-text-muted); }
    .mobile-nav a.active {
      color: var(--color-primary);
      background: var(--color-primary-soft);
      box-shadow: var(--glow-primary);
    }
    .mobile-nav a.active :global(svg) { color: var(--color-primary); }
  }

  @media (max-width: 640px) {
    /* LT-19 — the phone topbar joins the tablet range's STICKY pattern
       (the 641-1024px rule above, probe-proven to pin through scrolls):
       position:fixed headers are the Chrome-Android fixed-layer class that
       fails to re-anchor during URL-bar show/hide scroll transitions (the
       reported ~25% crop on scroll-up, recovering on direction change).
       Sticky is regular scrolled content — immune. The phone height +
       safe-area padding rules are kept verbatim, so the geometry is
       pixel-identical; the former .app-main padding-top compensation is
       gone because the in-flow topbar now provides the offset itself. */
    .topbar {
      height: var(--topbar-h-safe);
      padding: env(safe-area-inset-top, 0px) 16px 0;
    }
    .page-shell { padding-bottom: 0; }

    /* Phone-size refinements for the shared touch pill: tighter max
       width + compact labels (the tablet range keeps the roomier size). */
    .mobile-nav { width: min(calc(100% - 24px), 420px); }
    .mobile-nav a { font-size: .54rem; }
  }

  /* 2026-11 desktop-UX fix: the former fixed top-right glass chip (a
     Search link mis-named as the account control) is REMOVED; desktop
     Search lives inside the sidebar, and the account surfaces are the
     Upcoming / My List / Settings links + the user chip (2026-11
     account-IA pass). No desktop floating chrome remains. */

  @media (prefers-reduced-motion: reduce) {
    .sidebar-link, .sidebar-user, .social-btn, button.brand-lockup, .topbar-account, .mobile-nav a { transition: none; }
  }
</style>
