<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { navigating } from '$app/state';
  import { Search, UserRound, Compass, Menu, ChevronDown } from 'lucide-svelte';
  import RouteLoading from '$components/RouteLoading.svelte';
  import type { User } from '@supabase/supabase-js';

  let { children, currentPath = '/', user = null }: { children: Snippet; currentPath?: string; user?: User | null } = $props();
  let shell: HTMLElement;
  let navOpen = $state(false);

  const primaryLinks = [
    { label: 'Discover', href: '/discover', key: '/discover' },
    { label: 'Search', href: '/search', key: '/search' },
    { label: 'Profile', href: '/profile', key: '/profile' }
  ];

  const isActive = (key: string) => currentPath === key || currentPath.startsWith(`${key}/`);
  function handleWindowKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') navOpen = false;
  }

  const avatarLabel = (account: User | null | undefined) => {
    const name = typeof account?.user_metadata?.display_name === 'string' ? account.user_metadata.display_name : account?.email ?? '';
    return name.split(/\\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'AM';
  };

  onMount(async () => {
    const { gsap } = await import('gsap');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || !shell) return;
    gsap.fromTo(shell, { opacity: 0 }, { opacity: 1, duration: 0.45, ease: 'power2.out' });
  });
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<svelte:head>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
</svelte:head>

<div class="page-shell" bind:this={shell}>
  <header class="topbar">
    <a class="wordmark" href="/discover" aria-label="MAVERO home">MAVERO<span>.</span></a>

    <nav class="desktop-nav" aria-label="Primary navigation">
      {#each primaryLinks as link}
        <a class:active={isActive(link.key)} class="nav-link" href={link.href} aria-current={isActive(link.key) ? 'page' : undefined}>{link.label}</a>
      {/each}
    </nav>

    <div class="topbar-actions">
      <a class="icon-btn" href="/search" aria-label="Search MAVERO"><Search size={17} strokeWidth={1.8} /></a>
      <a class="avatar" href="/profile" aria-label="Open profile">{avatarLabel(user)}</a>
      <button class="icon-btn menu-trigger" aria-label={navOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={navOpen} aria-controls="mobile-menu" onclick={() => (navOpen = !navOpen)}>
        <Menu size={17} strokeWidth={1.8} />
      </button>
    </div>
  </header>

  {#if navOpen}
    <div id="mobile-menu" class="mobile-menu" role="region" aria-label="Navigation menu">
      <div class="mobile-menu-inner">
        <span class="eyebrow">MAVERO / Navigate</span>
        {#each primaryLinks as link}
          <a class:active={isActive(link.key)} href={link.href} aria-current={isActive(link.key) ? 'page' : undefined} onclick={() => (navOpen = false)}>{link.label}<ChevronDown size={16} /></a>
        {/each}
      </div>
    </div>
  {/if}

  <main>
    {@render children()}
  </main>

  {#if navigating.to}<RouteLoading />{/if}

  <nav class="mobile-nav" aria-label="Mobile navigation">
    <a class:active={isActive('/discover')} href="/discover" aria-current={isActive('/discover') ? 'page' : undefined} aria-label="Discover"><Compass size={18} strokeWidth={1.8} /><span>Discover</span></a>
    <a class:active={isActive('/search')} href="/search" aria-current={isActive('/search') ? 'page' : undefined} aria-label="Search"><Search size={18} strokeWidth={1.8} /><span>Search</span></a>
    <a class:active={isActive('/profile')} href="/profile" aria-current={isActive('/profile') ? 'page' : undefined} aria-label="Profile"><UserRound size={18} strokeWidth={1.8} /><span>Profile</span></a>
  </nav>
</div>

<style>
  .mobile-menu { position: fixed; inset: 68px 0 auto; z-index: 30; border-bottom: 1px solid var(--line); background: rgba(9,10,12,.96); backdrop-filter: blur(18px); }
  .mobile-menu-inner { display: grid; gap: 5px; width: min(100% - 40px, 1440px); margin: auto; padding: 18px 0 24px; }
  .mobile-menu a { display: flex; align-items: center; justify-content: space-between; padding: 13px 0; color: var(--muted); font-size: .94rem; font-weight: 800; text-decoration: none; }
  .mobile-menu a.active { color: var(--ink); }
  .menu-trigger { display: none; }
  @media (max-width: 640px) { .menu-trigger { display: grid; } }
</style>
