<script lang="ts">
  import { Database, Layers3, ShieldCheck, SlidersHorizontal } from 'lucide-svelte';

  export let active: 'overview' | 'providers' | 'sources' | 'categories' = 'overview';

  const links = [
    { id: 'overview', label: 'Overview', href: '/admin', icon: Database },
    { id: 'providers', label: 'Providers', href: '/admin/providers', icon: ShieldCheck },
    { id: 'sources', label: 'Sources', href: '/admin/sources', icon: SlidersHorizontal },
    { id: 'categories', label: 'Categories', href: '/admin/categories', icon: Layers3 },
  ] as const;
</script>

<div class="admin-shell">
  <aside class="admin-nav" aria-label="Admin navigation">
    <a class="admin-brand" href="/admin">MAVERO <span>/ Control room</span></a>
    <nav>
      {#each links as link}
        <a class:active={active === link.id} href={link.href} aria-current={active === link.id ? 'page' : undefined}>
          <svelte:component this={link.icon} size={14} /> {link.label}
        </a>
      {/each}
    </nav>
    <div class="admin-note"><div class="eyebrow">Phase 7A</div><p>Registry foundation only. Templates remain inert until a later approved phase.</p></div>
  </aside>
  <main class="admin-content"><slot /></main>
</div>

<style>
  .admin-shell { display: grid; grid-template-columns: 224px minmax(0, 1fr); min-height: 100vh; background: var(--base); }
  .admin-nav { position: sticky; top: 0; height: 100vh; padding: 30px 16px; border-right: 1px solid var(--line); background: rgba(10,14,16,.88); }
  .admin-brand { display: block; margin: 0 0 34px; color: var(--ink); font-family: 'Space Grotesk', sans-serif; font-size: .78rem; font-weight: 700; letter-spacing: .14em; text-decoration: none; }
  .admin-brand span { display: block; margin-top: 7px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .5rem; letter-spacing: .05em; }
  nav { display: grid; gap: 5px; }
  nav a { display: flex; align-items: center; gap: 9px; padding: 11px 12px; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--muted); font-size: .72rem; text-decoration: none; transition: color 180ms var(--ease-out), background 180ms var(--ease-out), border-color 180ms var(--ease-out); }
  nav a:hover, nav a.active { color: var(--ink); border-color: rgba(212,168,106,.18); background: var(--accent-soft); }
  .admin-note { position: absolute; right: 16px; bottom: 25px; left: 16px; padding: 13px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface); }
  .admin-note p { margin: 7px 0 0; color: var(--muted-deep); font-size: .64rem; line-height: 1.5; }
  .admin-content { width: min(1180px, 100%); padding: 58px clamp(20px, 5vw, 78px) 80px; }
  @media (max-width: 760px) { .admin-shell { display: block; } .admin-nav { position: static; height: auto; padding: 18px 16px 10px; border-right: 0; border-bottom: 1px solid var(--line); } .admin-brand { margin-bottom: 13px; } nav { display: flex; overflow-x: auto; gap: 4px; scrollbar-width: none; } nav::-webkit-scrollbar { display: none; } nav a { flex: 0 0 auto; } .admin-note { display: none; } .admin-content { padding: 30px 16px 56px; } }
</style>
