<script lang="ts">
  import { ArrowUpRight, Database, Layers3, ShieldCheck, SlidersHorizontal, Wifi } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import type { PageData } from './$types';

  export let data: PageData;
</script>

<svelte:head>
  <title>Admin Registry — Mavero</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminShell active="overview">
  <div class="eyebrow">MAVERO / Admin registry</div>
  <h1>Control the<br /><em>configuration.</em></h1>
  <p class="admin-intro">Provider, source, and category configuration is stored in Supabase and versioned independently of the public application.</p>

  <section class="admin-grid" aria-label="MAVERO streaming registry summary">
    <div class="admin-stat"><div class="eyebrow">Providers</div><strong>{data.overview.providerCount}</strong><span class="stat-foot"><ShieldCheck size={13} /> {data.overview.activeProviderCount} enabled</span></div>
    <div class="admin-stat"><div class="eyebrow">Sources</div><strong>{data.overview.sourceCount}</strong><span class="stat-foot"><Wifi size={13} /> {data.overview.activeSourceCount} enabled</span></div>
    <div class="admin-stat"><div class="eyebrow">Categories</div><strong>{data.overview.categoryCount}</strong><span class="stat-foot"><Layers3 size={13} /> custom ordering</span></div>
    <div class="admin-stat"><div class="eyebrow">Config version</div><strong>v{data.overview.configVersion}</strong><span class="stat-foot"><Database size={13} /> invalidates on mutation</span></div>
  </section>

  <div class="admin-section-head"><div><div class="eyebrow">Registry foundation</div><h2>Manage the streaming catalog</h2></div><span class="version">Updated {new Date(data.overview.configUpdatedAt).toLocaleString()}</span></div>
  <div class="admin-cards">
    <a class="admin-card" href="/admin/providers"><span class="card-icon"><ShieldCheck size={18} /></span><div><h3>Providers</h3><p>Define integrations, states, capabilities, and safe display metadata.</p></div><ArrowUpRight size={16} /></a>
    <a class="admin-card" href="/admin/sources"><span class="card-icon"><SlidersHorizontal size={18} /></span><div><h3>Sources</h3><p>Configure selectable source metadata and inert media templates.</p></div><ArrowUpRight size={16} /></a>
    <a class="admin-card" href="/admin/categories"><span class="card-icon"><Layers3 size={18} /></span><div><h3>Categories</h3><p>Organize public sources with category-specific ordering.</p></div><ArrowUpRight size={16} /></a>
  </div>

  <div class="admin-lower-grid">
    <section class="admin-panel"><div class="eyebrow">Configuration status</div><h3>Sanitized public contract</h3><p>The public service exposes only enabled, visible records and safe capabilities. Credentials, templates, internal notes, and admin-only metadata remain server-side.</p><span class="security-line"><ShieldCheck size={15} /> RLS and server authorization active</span></section>
    <section class="admin-panel"><div class="eyebrow">Deferred by design</div><h3>No playback activation</h3><p>Phase 7A stores configuration only. It does not resolve URLs, call providers, activate embeds, or implement the MAVERO Player.</p><span class="security-line"><Database size={15} /> Phase 7A boundary intact</span></section>
  </div>
</AdminShell>

<style>
  em { color: var(--accent); font-style: normal; }
  .admin-intro { max-width: 600px; margin: 0; color: var(--muted); font-size: .82rem; line-height: 1.7; }
  .admin-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 30px; }
  .admin-stat { min-height: 125px; padding: 17px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
  .admin-stat strong { display: block; margin-top: 10px; color: var(--ink); font-size: 2rem; letter-spacing: -.08em; }
  .stat-foot { display: inline-flex; align-items: center; gap: 6px; margin-top: 12px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .56rem; }
  .admin-section-head { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-top: 58px; }
  .admin-section-head h2 { margin: 7px 0 0; font-size: 1.25rem; letter-spacing: -.05em; }
  .version { color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .56rem; }
  .admin-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 15px; }
  .admin-card { display: flex; align-items: center; gap: 12px; min-height: 130px; padding: 17px; border: 1px solid var(--line); border-radius: 14px; color: var(--ink); background: var(--surface); text-decoration: none; transition: transform .18s ease, border-color .18s ease, background .18s ease; }
  .admin-card:hover { transform: translateY(-2px); border-color: rgba(155,135,245,.45); background: var(--surface-raised); }
  .admin-card > div { flex: 1; }
  .card-icon { display: grid; place-items: center; width: 35px; height: 35px; border-radius: 10px; color: var(--accent); background: var(--accent-soft); }
  .admin-card h3, .admin-panel h3 { margin: 0 0 7px; font-size: .92rem; letter-spacing: -.035em; }
  .admin-card p, .admin-panel p { margin: 0; color: var(--muted); font-size: .7rem; line-height: 1.55; }
  .admin-lower-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 15px; }
  .admin-panel { padding: 20px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
  .admin-panel h3 { margin-top: 9px; }
  .security-line { display: inline-flex; align-items: center; gap: 7px; margin-top: 16px; color: var(--success); font-family: 'DM Mono', monospace; font-size: .57rem; }
  @media (max-width: 850px) { .admin-grid { grid-template-columns: repeat(2, 1fr); } .admin-cards { grid-template-columns: 1fr; } }
  @media (max-width: 640px) { .admin-section-head { align-items: start; flex-direction: column; gap: 10px; } .admin-lower-grid { grid-template-columns: 1fr; } }
</style>
