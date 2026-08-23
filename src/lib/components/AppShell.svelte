<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { navigating } from '$app/state';
  import { Bookmark, Compass, Search, UserRound, Settings2, Bell, Clapperboard } from 'lucide-svelte';
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
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'MV';
  };

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
      <a class="rail-link" href="/profile#preferences"><Settings2 size={18} strokeWidth={1.8} /><span>Preferences</span></a>
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
      <a class="topbar-search" href="/search"><Search size={16} /><span>Search movies, series, anime…</span><kbd>/</kbd></a>
      <div class="topbar-actions">
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
      <a class:active={isActive(link.key)} href={link.href} aria-current={isActive(link.key) ? 'page' : undefined} aria-label={link.label}><Icon size={20} strokeWidth={isActive(link.key) ? 2.3 : 1.8} /><span>{link.label}</span></a>
    {/each}
  </nav>
</div>

<style>
  .page-shell { display: grid; grid-template-columns: 216px minmax(0, 1fr); }
  .app-rail {
    position: sticky; top: 0; z-index: 45; display: flex; flex-direction: column;
    height: 100dvh; padding: 22px 14px 20px; border-right: 1px solid var(--line);
    background: rgba(10, 10, 16, .9); backdrop-filter: blur(16px);
  }
  .brand-lockup, .mobile-brand { display: inline-flex; align-items: center; gap: 9px; padding: 0 6px; color: var(--ink); text-decoration: none; }
  .brand-symbol {
    display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px;
    color: #fff; background: var(--accent-gradient); box-shadow: 0 6px 16px rgba(255, 56, 96, .3);
  }
  .brand-word { font-size: .92rem; font-weight: 900; letter-spacing: .04em; }
  .rail-nav { display: grid; gap: 2px; margin-top: 34px; }
  .rail-link {
    display: flex; align-items: center; gap: 13px; min-height: 46px; padding: 0 12px;
    border: 1px solid transparent; border-radius: 10px; color: var(--muted); font-size: .82rem; font-weight: 600;
    text-decoration: none;
    transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out);
  }
  .rail-link:hover { color: var(--ink); background: rgba(245, 246, 250, .06); transform: translateX(2px); }
  .rail-link.active { color: var(--ink); font-weight: 700; border-color: rgba(255, 62, 94, .28); background: linear-gradient(90deg, var(--accent-soft), transparent 85%); }
  .rail-link.active :global(svg) { color: var(--accent-strong); }
  .rail-bottom { display: grid; gap: 14px; margin-top: auto; }
  .rail-rule { height: 1px; background: var(--line); }
  .rail-caption { padding: 0 12px; max-width: 150px; color: var(--muted-deep); font-size: .68rem; font-weight: 500; line-height: 1.4; }
  .app-canvas { min-width: 0; }
  .topbar {
    position: sticky; top: 0; z-index: 40; display: grid; grid-template-columns: auto minmax(0, 460px) 1fr;
    align-items: center; gap: 20px; height: 72px; padding: 0 clamp(20px, 3vw, 48px);
    border-bottom: 1px solid var(--line); background: rgba(6, 6, 10, .86); backdrop-filter: blur(22px);
  }
  .mobile-brand { display: none; }
  .topbar-search {
    display: inline-flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 14px;
    border: 1px solid var(--line); border-radius: 10px; color: var(--muted); background: rgba(245, 246, 250, .04);
    font-size: .76rem; text-decoration: none;
    transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
  }
  .topbar-search:hover, .topbar-search:focus-visible { border-color: rgba(255, 62, 94, .4); background: rgba(255, 56, 96, .06); color: var(--ink); }
  .topbar-search span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  kbd { border: 1px solid var(--line); border-radius: 4px; padding: 2px 6px; color: var(--muted-deep); font-size: .62rem; font-weight: 600; }
  .topbar-actions { display: flex; align-items: center; justify-self: end; gap: 10px; }
  .avatar {
    display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; color: #fff;
    background: var(--accent-gradient); font-size: .68rem; font-weight: 800; text-decoration: none;
    box-shadow: 0 4px 14px rgba(255, 56, 96, .25);
  }
  @media (max-width: 900px) {
    .page-shell { display: block; }
    .app-rail { display: none; }
    .topbar { grid-template-columns: auto 1fr auto; }
    .mobile-brand { display: inline-flex; }
    .topbar-search span, .topbar-search kbd { display: none; }
    .topbar-search { width: 40px; padding: 0; justify-content: center; border-color: transparent; background: transparent; }
  }
  @media (max-width: 640px) {
    .topbar { position: fixed; width: 100%; box-sizing: border-box; height: calc(62px + env(safe-area-inset-top)); padding: env(safe-area-inset-top) 16px 0; }
    .notification-btn { display: none; }
    .page-shell { padding-bottom: 80px; }
    .mobile-nav {
      position: fixed; right: 0; bottom: 0; left: 0; z-index: 50; display: grid; grid-template-columns: repeat(4, 1fr);
      padding: 8px 10px calc(8px + env(safe-area-inset-bottom)); border-top: 1px solid var(--line);
      background: rgba(8, 8, 13, .96); backdrop-filter: blur(20px);
    }
    .mobile-nav a { display: grid; place-items: center; gap: 4px; min-height: 46px; color: var(--muted-deep); font-size: .58rem; font-weight: 700; text-decoration: none; }
    .mobile-nav a.active { color: var(--ink); }
    .mobile-nav a.active :global(svg) { color: var(--accent-strong); }
  }
  @media (min-width: 641px) { .mobile-nav { display: none; } }
</style>
