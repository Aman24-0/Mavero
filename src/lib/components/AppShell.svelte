<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { navigating } from '$app/state';
  import { Bookmark, Compass, Search, UserRound, Settings2, Bell } from 'lucide-svelte';
  import RouteLoading from '$components/RouteLoading.svelte';
  import type { User } from '@supabase/supabase-js';

  let { children, currentPath = '/', user = null }: { children: Snippet; currentPath?: string; user?: User | null } = $props();
  let shell: HTMLElement;

  const primaryLinks = [
    { label: 'Discover', href: '/discover', key: '/discover', icon: Compass },
    { label: 'Search', href: '/search', key: '/search', icon: Search },
    { label: 'My List', href: '/my-list', key: '/my-list', icon: Bookmark },
    { label: 'Profile', href: '/profile', key: '/profile', icon: UserRound }
  ];

  const isActive = (key: string) => currentPath === key || currentPath.startsWith(`${key}/`);
  const avatarLabel = (account: User | null | undefined) => {
    const name = typeof account?.user_metadata?.display_name === 'string' ? account.user_metadata.display_name : account?.email ?? '';
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'AM';
  };

  onMount(async () => {
    const { gsap } = await import('gsap');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || !shell) return;
    gsap.fromTo(shell, { opacity: 0 }, { opacity: 1, duration: 0.52, ease: 'power2.out' });
  });
</script>

<svelte:head>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" />
</svelte:head>

<div class="page-shell" bind:this={shell}>
  <aside class="app-rail" aria-label="Primary navigation">
    <a class="brand-lockup" href="/discover" aria-label="MAVERO home"><span class="brand-symbol">M</span><span class="brand-word">MAVERO</span></a>
    <nav class="rail-nav">
      <div class="rail-label">Browse</div>
      {#each primaryLinks as link}
        {@const Icon = link.icon}
        <a class:active={isActive(link.key)} class="rail-link" href={link.href} aria-current={isActive(link.key) ? 'page' : undefined}>
          <Icon size={17} strokeWidth={1.8} /><span>{link.label}</span>
        </a>
      {/each}
    </nav>
    <div class="rail-bottom">
      <a class="rail-link" href="/profile#preferences"><Settings2 size={17} strokeWidth={1.8} /><span>Preferences</span></a>
      <div class="rail-rule"></div>
      <span class="rail-caption">Stories worth staying for.</span>
    </div>
  </aside>

  <div class="app-canvas">
    <header class="topbar">
      <div class="mobile-brand"><span class="brand-symbol">M</span><span class="brand-word">MAVERO</span></div>
      <div class="topbar-context">{isActive('/discover') ? 'Discover something new' : isActive('/my-list') ? 'Your saved library' : isActive('/profile') ? 'Your space' : 'Mavero'}</div>
      <div class="topbar-actions">
        <a class="topbar-search" href="/search"><Search size={16} /><span>Search stories, people, genres...</span><kbd>/</kbd></a>
        <a class="icon-btn notification-btn" href="/profile" aria-label="Open profile notifications"><Bell size={17} /></a>
        <a class="avatar" href="/profile" aria-label="Open profile">{avatarLabel(user)}</a>
      </div>
    </header>

    <main>{@render children()}</main>
    {#if navigating.to}<RouteLoading />{/if}
  </div>

  <nav class="mobile-nav" aria-label="Mobile navigation">
    {#each primaryLinks as link}
      {@const Icon = link.icon}
      <a class:active={isActive(link.key)} href={link.href} aria-current={isActive(link.key) ? 'page' : undefined} aria-label={link.label}><Icon size={19} strokeWidth={1.8} /><span>{link.label}</span></a>
    {/each}
  </nav>
</div>

<style>
  .page-shell { display: grid; grid-template-columns: 232px minmax(0, 1fr); }
  .app-rail { position: sticky; top: 0; z-index: 45; display: flex; flex-direction: column; height: 100dvh; padding: 28px 17px 24px; border-right: 1px solid var(--line); background: rgba(13, 15, 15, .82); }
  .brand-lockup, .mobile-brand { display: inline-flex; align-items: center; gap: 10px; color: var(--ink); text-decoration: none; }
  .brand-symbol { display: grid; place-items: center; width: 26px; height: 26px; border: 1px solid rgba(216,163,78,.65); border-radius: 50%; color: var(--accent-strong); font-family: 'Cormorant Garamond', Georgia, serif; font-size: 1.1rem; font-weight: 700; }
  .brand-word { font-size: .84rem; font-weight: 800; letter-spacing: .2em; }
  .rail-nav { margin-top: 62px; }
  .rail-label { margin: 0 12px 10px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .53rem; letter-spacing: .14em; text-transform: uppercase; }
  .rail-link { display: flex; align-items: center; gap: 11px; min-height: 44px; padding: 0 12px; border: 1px solid transparent; border-radius: 10px; color: var(--muted); font-size: .72rem; font-weight: 700; text-decoration: none; transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  .rail-link:hover { color: var(--ink); background: rgba(245,241,232,.045); transform: translateX(2px); }
  .rail-link.active { color: var(--ink); border-color: rgba(216,163,78,.22); background: linear-gradient(90deg, var(--accent-soft), transparent); }
  .rail-link.active :global(svg) { color: var(--accent-strong); }
  .rail-bottom { display: grid; gap: 12px; margin-top: auto; }
  .rail-rule { height: 1px; background: var(--line); }
  .rail-caption { max-width: 135px; color: var(--muted-deep); font-family: 'Cormorant Garamond', Georgia, serif; font-size: .95rem; font-style: italic; line-height: 1.15; }
  .app-canvas { min-width: 0; }
  .topbar { position: sticky; top: 0; z-index: 40; display: grid; grid-template-columns: 1fr minmax(250px, 480px) 1fr; align-items: center; height: 78px; padding: 0 clamp(24px, 4vw, 56px); border-bottom: 1px solid rgba(245,241,232,.075); background: rgba(9,10,11,.82); backdrop-filter: blur(24px); }
  .topbar-context { color: var(--muted); font-family: 'Cormorant Garamond', Georgia, serif; font-size: 1.2rem; font-style: italic; }
  .topbar-actions { display: flex; align-items: center; justify-self: end; gap: 10px; }
  .topbar-search { display: inline-flex; align-items: center; gap: 9px; width: min(34vw, 310px); min-height: 36px; padding: 0 11px; border: 1px solid var(--line); border-radius: 9px; color: var(--muted-deep); background: rgba(245,241,232,.035); font-size: .64rem; text-decoration: none; }
  .topbar-search span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  kbd { border: 1px solid var(--line); border-radius: 4px; padding: 2px 5px; color: var(--muted); font-family: 'DM Mono', monospace; font-size: .55rem; }
  .mobile-brand { display: none; }
  @media (max-width: 900px) { .page-shell { display: block; } .app-rail { display: none; } .topbar { grid-template-columns: 1fr auto; } .mobile-brand { display: inline-flex; } .topbar-context { display: none; } .topbar-actions { gap: 7px; } .topbar-search { width: 38px; padding-inline: 10px; } .topbar-search span, .topbar-search kbd { display: none; } }
  @media (max-width: 640px) { .topbar { position: fixed; width: 100%; box-sizing: border-box; height: calc(66px + env(safe-area-inset-top)); padding: env(safe-area-inset-top) 16px 0; } .notification-btn { display: none; } .topbar-search { border: 0; background: transparent; } .page-shell { padding-bottom: 82px; } .mobile-nav { position: fixed; right: 0; bottom: 0; left: 0; z-index: 50; display: grid; grid-template-columns: repeat(4, 1fr); padding: 9px 14px calc(9px + env(safe-area-inset-bottom)); border-top: 1px solid var(--line); background: rgba(14,16,16,.94); backdrop-filter: blur(20px); } .mobile-nav a { display: grid; place-items: center; gap: 5px; min-height: 46px; color: var(--muted-deep); font-size: .59rem; font-weight: 800; text-decoration: none; } .mobile-nav a.active { color: var(--ink); } .mobile-nav a.active :global(svg) { color: var(--accent-strong); } }
  @media (min-width: 641px) { .mobile-nav { display: none; } }
</style>
