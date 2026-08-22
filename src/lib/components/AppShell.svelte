<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { navigating } from '$app/state';
  import { Bookmark, Compass, Search, UserRound } from 'lucide-svelte';
  import RouteLoading from '$components/RouteLoading.svelte';
  import type { User } from '@supabase/supabase-js';

  let { children, currentPath = '/', user = null }: { children: Snippet; currentPath?: string; user?: User | null } = $props();
  let shell: HTMLElement;

  const primaryLinks = [
    { label: 'Discover', href: '/discover', key: '/discover', icon: Compass },
    { label: 'Search', href: '/search', key: '/search', icon: Search },
    { label: 'My List', href: '/my-list', key: '/my-list', icon: Bookmark }
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
    gsap.fromTo(shell, { opacity: 0 }, { opacity: 1, duration: 0.42, ease: 'power2.out' });
  });
</script>

<svelte:head>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" />
</svelte:head>

<div class="page-shell" bind:this={shell}>
  <header class="topbar">
    <a class="wordmark" href="/discover" aria-label="MAVERO home">MAVERO<span>.</span></a>
    <nav class="desktop-nav" aria-label="Primary navigation">
      {#each primaryLinks as link}
        {@const Icon = link.icon}
        <a class:active={isActive(link.key)} class="nav-link" href={link.href} aria-current={isActive(link.key) ? 'page' : undefined}>
          <Icon size={14} strokeWidth={1.8} />
          <span>{link.label}</span>
        </a>
      {/each}
    </nav>
    <div class="topbar-actions">
      <a class="icon-btn search-action" href="/search" aria-label="Search MAVERO"><Search size={17} strokeWidth={1.8} /></a>
      <a class="avatar" href="/profile" aria-label="Open profile">{avatarLabel(user)}</a>
    </div>
  </header>

  <main>{@render children()}</main>
  {#if navigating.to}<RouteLoading />{/if}

  <nav class="mobile-nav" aria-label="Mobile navigation">
    {#each primaryLinks as link}
      {@const Icon = link.icon}
      <a class:active={isActive(link.key)} href={link.href} aria-current={isActive(link.key) ? 'page' : undefined} aria-label={link.label}>
        <Icon size={18} strokeWidth={1.8} />
        <span>{link.label}</span>
      </a>
    {/each}
    <a class:active={isActive('/profile')} href="/profile" aria-current={isActive('/profile') ? 'page' : undefined} aria-label="Profile"><UserRound size={18} strokeWidth={1.8} /><span>Profile</span></a>
  </nav>
</div>
