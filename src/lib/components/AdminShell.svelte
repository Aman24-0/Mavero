<script lang="ts">
  import { Database, Layers3, ShieldCheck, SlidersHorizontal, ArrowLeft, Activity } from 'lucide-svelte';
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
    <div class="admin-nav-top"><a class="admin-brand" href="/discover"><span class="brand-symbol">M</span><span>MAVERO</span><small>Control room</small></a><span class="admin-mode"><Activity size={12} /> Live</span></div>
    <nav><div class="admin-label">Workspace</div>{#each links as link}<a class:active={active === link.id} href={link.href} aria-current={active === link.id ? 'page' : undefined}><svelte:component this={link.icon} size={15} /> <span>{link.label}</span></a>{/each}</nav>
    <div class="admin-note"><div class="eyebrow">Phase 7A</div><p>Registry foundation only. Templates remain inert until a later approved phase.</p></div>
    <a class="admin-back" href="/discover"><ArrowLeft size={14} /> Back to app</a>
  </aside>
  <main class="admin-content"><slot /></main>
</div>

<style>
  .admin-shell { display: grid; grid-template-columns: 244px minmax(0, 1fr); min-height: 100vh; background: var(--base); }
  .admin-nav { position: sticky; top: 0; display: flex; flex-direction: column; height: 100vh; padding: 28px 16px 22px; border-right: 1px solid var(--line); background: rgba(13,15,15,.92); }
  .admin-nav-top { display: flex; align-items: start; justify-content: space-between; gap: 10px; }
  .admin-brand { display: grid; grid-template-columns: 28px auto; align-items: center; gap: 9px; color: var(--ink); font-family: 'Manrope', sans-serif; font-size: .78rem; font-weight: 800; letter-spacing: .18em; text-decoration: none; }
  .admin-brand .brand-symbol { display: grid; grid-row: span 2; place-items: center; width: 28px; height: 28px; border: 1px solid rgba(139,92,246,.62); border-radius: 50%; color: var(--accent-strong); font-family: 'Space Grotesk', sans-serif; font-size: 1.1rem; }
  .admin-brand small { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .48rem; font-weight: 400; letter-spacing: .05em; }
  .admin-mode { display: inline-flex; align-items: center; gap: 5px; color: var(--secondary); font-family: 'DM Mono', monospace; font-size: .52rem; text-transform: uppercase; }
  .admin-mode :global(svg) { color: var(--secondary); }
  nav { display: grid; gap: 5px; margin-top: 58px; }
  .admin-label { margin: 0 12px 9px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .53rem; letter-spacing: .14em; text-transform: uppercase; }
  nav a { display: flex; align-items: center; gap: 10px; min-height: 43px; padding: 0 12px; border: 1px solid transparent; border-radius: 10px; color: var(--muted); font-size: .72rem; font-weight: 700; text-decoration: none; transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
  nav a:hover { color: var(--ink); background: rgba(248,250,252,.045); transform: translateX(2px); }
  nav a.active { color: var(--ink); border-color: rgba(139,92,246,.25); background: linear-gradient(90deg, var(--accent-soft), transparent); }
  nav a.active :global(svg) { color: var(--accent-strong); }
  .admin-note { margin-top: auto; padding: 14px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface); }
  .admin-note p { margin: 8px 0 0; color: var(--muted-deep); font-size: .64rem; line-height: 1.5; }
  .admin-back { display: inline-flex; align-items: center; gap: 7px; margin-top: 18px; color: var(--muted); font-size: .66rem; text-decoration: none; }
  .admin-back:hover { color: var(--accent-strong); }
  .admin-content { width: min(1240px, 100%); padding: 58px clamp(24px, 5vw, 78px) 80px; }
  @media (max-width: 760px) { .admin-shell { display: block; } .admin-nav { position: static; height: auto; padding: 18px 16px 10px; border-right: 0; border-bottom: 1px solid var(--line); } nav { display: flex; overflow-x: auto; gap: 4px; margin-top: 24px; scrollbar-width: none; } nav::-webkit-scrollbar { display: none; } .admin-label, .admin-note, .admin-back { display: none; } nav a { flex: 0 0 auto; } .admin-content { padding: 34px 20px 66px; } }
</style>
