<script lang="ts">
  import { Activity, Database, Layers3, Plus, RefreshCw, Settings2, ShieldCheck, SlidersHorizontal, Users, Wifi } from 'lucide-svelte';

  const providers = [
    { name: 'VidLink', type: 'Embed', status: 'Healthy', support: 'Movie · TV · Anime', priority: '01' },
    { name: 'Mapple Player', type: 'Embed', status: 'Unknown', support: 'Movie · TV', priority: '02' },
    { name: 'MAVERO Direct', type: 'Direct', status: 'Experimental', support: 'Movie · TV · Anime', priority: '03' },
    { name: 'Peachify', type: 'Embed', status: 'Maintenance', support: 'Movie · TV', priority: '04' }
  ];

  let healthMessage = '';
  function refreshHealth() { healthMessage = 'Health snapshot queued · last checked just now'; }
</script>

<svelte:head>
  <title>Admin — Mavero</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<div class="admin-shell">
  <aside class="admin-nav" aria-label="Admin navigation">
    <div class="eyebrow admin-label">MAVERO / Control room</div>
    <a class="active" href="/admin">Overview</a>
    <a href="/admin/providers">Streaming providers</a>
    <a href="/admin/sources">Sources & ordering</a>
    <a href="/admin/categories">Categories</a>
    <a href="/admin/health">Provider health</a>
    <a href="/admin/content">Featured content</a>
    <a href="/admin/users">Users</a>
    <a href="/admin/settings">System settings</a>
  </aside>

  <main class="admin-content">
    <div class="eyebrow">MAVERO / Admin</div>
    <h1>Control the<br /><em>ecosystem.</em></h1>
    <p class="admin-intro">Provider configuration is database-driven. Every change below can invalidate public configuration without a frontend deployment.</p>

    <div class="admin-actions"><button class="btn btn-primary"><Plus size={15} /> Add provider</button><button class="btn btn-secondary" onclick={refreshHealth}><RefreshCw size={15} /> Run health check</button>{#if healthMessage}<span class="health-message">{healthMessage}</span>{/if}</div>

    <section class="admin-grid" aria-label="MAVERO admin summary">
      <div class="admin-stat"><div class="eyebrow">Active providers</div><strong>08</strong><span class="stat-foot"><Wifi size={13} /> 6 healthy</span></div>
      <div class="admin-stat"><div class="eyebrow">Public sources</div><strong>24</strong><span class="stat-foot"><Layers3 size={13} /> 4 categories</span></div>
      <div class="admin-stat"><div class="eyebrow">Config version</div><strong>1.4.8</strong><span class="stat-foot"><Database size={13} /> Cache synced</span></div>
      <div class="admin-stat"><div class="eyebrow">Active users</div><strong>1,284</strong><span class="stat-foot"><Users size={13} /> +12% this week</span></div>
    </section>

    <div class="admin-section-head"><div><div class="eyebrow">Registry</div><h2>Provider ecosystem</h2></div><button class="icon-btn" aria-label="Filter provider table"><SlidersHorizontal size={16} /></button></div>
    <div class="admin-table" role="table" aria-label="Provider registry">
      <div class="admin-row header" role="row"><span>Provider</span><span>Type</span><span>Status</span><span>Support</span><span>Priority</span></div>
      {#each providers as provider}
        <div class="admin-row" role="row"><strong>{provider.name}</strong><span>{provider.type}</span><span class:status={provider.status === 'Healthy'} class:status-warning={provider.status !== 'Healthy'}>{provider.status}</span><span>{provider.support}</span><span class="priority">{provider.priority}</span></div>
      {/each}
    </div>

    <div class="admin-lower-grid">
      <section class="admin-panel"><div class="eyebrow">Cache invalidation</div><h3>Public configuration</h3><p>Last mutation propagated 4 minutes ago. Provider order, category membership, and maintenance state are versioned.</p><button class="btn btn-secondary"><RefreshCw size={14} /> Invalidate cache</button></section>
      <section class="admin-panel"><div class="eyebrow">Security posture</div><h3>Server-side by default</h3><p>Admin access, RLS, template validation, audit logging, and provider sandbox policy are enforced outside the public UI.</p><span class="security-line"><ShieldCheck size={15} /> All systems nominal</span></section>
    </div>
  </main>
</div>

<style>
  em { color: var(--accent); font-style: normal; }
  .admin-label { margin: 0 0 18px 12px; }
  .admin-intro { max-width: 550px; margin: 0; color: var(--muted); font-size: .82rem; line-height: 1.7; }
  .admin-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; margin-top: 25px; }
  .health-message { color: var(--success); font-family: 'DM Mono', monospace; font-size: .61rem; }
  .stat-foot { display: inline-flex; align-items: center; gap: 6px; margin-top: 15px; color: var(--muted-deep); font-family: 'DM Mono', monospace; font-size: .58rem; }
  .admin-section-head { display: flex; align-items: end; justify-content: space-between; margin-top: 58px; }
  .admin-section-head h2 { margin: 7px 0 0; font-size: 1.25rem; letter-spacing: -.05em; }
  .status-warning { color: #d4b27c; }
  .priority { color: var(--accent); font-family: 'DM Mono', monospace; }
  .admin-lower-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 13px; margin-top: 14px; }
  .admin-panel { padding: 21px; border: 1px solid var(--line); border-radius: 15px; background: var(--surface); }
  .admin-panel h3 { margin: 9px 0 8px; font-size: 1.05rem; letter-spacing: -.04em; }
  .admin-panel p { margin: 0 0 18px; color: var(--muted); font-size: .75rem; line-height: 1.65; }
  .security-line { display: inline-flex; align-items: center; gap: 7px; color: var(--success); font-family: 'DM Mono', monospace; font-size: .6rem; }
  @media (max-width: 640px) { .admin-lower-grid { grid-template-columns: 1fr; } }
</style>
