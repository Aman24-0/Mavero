<script lang="ts">
  import '$lib/../app.css';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import AppShell from '$components/AppShell.svelte';
  import PwaExperience from '$components/PwaExperience.svelte';
  import Toast from '$components/Toast.svelte';
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';
  import { syncAuthenticatedState } from '$lib/client/progress/cloud';

  let { children: pageChildren, data }: { children: Snippet; data: LayoutData } = $props();
  const title = 'Mavero — Movies, series & anime';

  onMount(() => {
    if (!data.user) return;
    void syncAuthenticatedState();
    const retry = () => { if (navigator.onLine) void syncAuthenticatedState(); };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  });

  // Root layout snapshot — captures the window scroll position whenever
  // the user navigates away from any page in the app, and restores it
  // when the user navigates back via the browser Back/Forward button or
  // via `history.back()` (which is what the DetailPage back-arrow icon
  // uses when there's a valid internal `from` parameter).
  //
  // Why a snapshot instead of a custom scroll Map
  // ============================================
  // SvelteKit already restores scroll on `popstate` navigations via its
  // own `scroll_positions[history_index]` map (persisted to sessionStorage
  // on `visibilitychange` / `beforeunload`). That handles the browser
  // Back/Forward case directly.
  //
  // This snapshot exists as a complementary mechanism: it captures the
  // scroll position at the moment of navigation (via the snapshot
  // `capture()` lifecycle) and restores it on `popstate` (via `restore()`).
  // Using the snapshot model means we don't need a custom beforeNavigate /
  // afterNavigate / disableScrollHandling orchestration — SvelteKit's
  // router already wires the capture/restore lifecycle to the right
  // moments in the navigation flow.
  //
  // The snapshot is keyed by navigation index (SvelteKit manages that
  // internally) — so it correctly distinguishes between fresh forward
  // navigations (which should start at the top) and back-like popstate
  // navigations (which should restore the previous scroll position).
  //
  // Forward navigation (link click, fresh goto) does NOT trigger
  // `restore()` — only `popstate` does. So clicking Discover in the
  // bottom nav while on a deep-scroll Search page correctly starts at
  // the top of Discover rather than inheriting Search's scroll.
  //
  // The restore happens on `requestAnimationFrame` so the DOM has had
  // a chance to lay out — for pages whose height depends on async data
  // (e.g. My List loading from IndexedDB), restoring synchronously
  // could land at a position the page hasn't grown to yet.
  //
  // Note: this is the ROOT layout snapshot. It runs alongside any
  // per-page snapshots (e.g. the Search page's query/type/results
  // snapshot). SvelteKit captures and restores ALL component snapshots
  // (layout + page) atomically on navigation, so scroll + page state
  // always restore together.
  export const snapshot = {
    capture: (): { x: number; y: number } => {
      if (typeof window === 'undefined') return { x: 0, y: 0 };
      return { x: window.scrollX, y: window.scrollY };
    },
    restore: (value: { x: number; y: number }) => {
      if (typeof window === 'undefined') return;
      if (!value || typeof value !== 'object') return;
      const x = Number.isFinite(value.x) ? value.x : 0;
      const y = Number.isFinite(value.y) ? value.y : 0;
      requestAnimationFrame(() => {
        // Clamp to current document bounds — if the page hasn't grown to
        // the saved height yet (async data still loading), this still
        // scrolls as far as possible.
        const maxX = document.documentElement.scrollWidth - window.innerWidth;
        const maxY = document.documentElement.scrollHeight - window.innerHeight;
        window.scrollTo(
          Math.max(0, Math.min(x, Math.max(0, maxX))),
          Math.max(0, Math.min(y, Math.max(0, maxY)))
        );
      });
    }
  };
</script>

<svelte:head>
  <title>{title}</title>
  <meta property="og:title" content={title} />
  <meta property="og:description" content="A fast, modern home for your next watch." />
  <meta name="twitter:card" content="summary_large_image" />
</svelte:head>

{#if page.url.pathname.startsWith('/watch/') || /^\/(movie|series|anime)\/[^/]+/.test(page.url.pathname) || page.url.pathname.startsWith('/auth/') || page.url.pathname.startsWith('/admin')}
  <!-- /admin/* renders bare too: AdminShell is a self-contained
       administrative layout with its OWN navigation. The consumer
       AppShell (side rail + mobile bottom nav) must not render there at
       all — not hidden, not covered — so admin never shows the normal
       Discover/Search/My List/Profile navigation. -->
  {@render pageChildren()}
{:else}
  <AppShell currentPath={page.url.pathname} showMobileNav={!page.url.pathname.startsWith('/settings')}>
    {#snippet children()}
      {@render pageChildren()}
    {/snippet}
  </AppShell>
{/if}

<PwaExperience />
<Toast />
