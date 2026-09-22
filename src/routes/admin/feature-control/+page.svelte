<script lang="ts">
  import { onMount } from 'svelte';
  import { Check, ShieldCheck } from 'lucide-svelte';
  import AdminShell from '$lib/components/AdminShell.svelte';
  import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
  import AdminSection from '$lib/components/admin/AdminSection.svelte';

  // Adult Mode admin policy state (API-driven, not form-action).
  // MOVED from /admin/defaults — this is now the single authoritative UI.
  let adultPolicy = $state<{ allowLoggedIn: boolean; allowGuest: boolean }>({ allowLoggedIn: false, allowGuest: false });
  let adultPolicyLoading = $state(false);
  let adultPolicySaved = $state(false);

  async function loadAdultPolicy() {
    try {
      const response = await fetch('/api/admin/adult-mode');
      if (!response.ok) return;
      const payload = await response.json();
      if (payload.ok && payload.policy) {
        adultPolicy = { ...payload.policy };
      }
    } catch { /* ignore */ }
  }

  async function toggleAdultPolicy(field: 'allowLoggedIn' | 'allowGuest') {
    adultPolicyLoading = true;
    adultPolicySaved = false;
    try {
      const response = await fetch('/api/admin/adult-mode', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [field]: !adultPolicy[field] }),
      });
      if (!response.ok) return;
      const payload = await response.json();
      if (payload.ok && payload.policy) {
        adultPolicy = { ...payload.policy };
        adultPolicySaved = true;
        setTimeout(() => { adultPolicySaved = false; }, 2500);
      }
    } catch { /* ignore */ }
    adultPolicyLoading = false;
  }

  onMount(() => { void loadAdultPolicy(); });
</script>

<svelte:head><title>Feature Control — Mavero</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<AdminShell active="feature-control">
  <AdminPageHeader
    eyebrow="MAVERO / Feature control"
    title="Feature"
    accent="control."
  />

  {#if adultPolicySaved}<div class="notice" role="status"><Check size={15} /> Policy updated.</div>{/if}

  <AdminSection
    eyebrow="Adult Mode"
    title="Adult Mode"
  >
    {#snippet actions()}
      <ShieldCheck size={14} />
      <span class="hint">Server-authoritative</span>
    {/snippet}
    <div class="feature-toggles">
      <label class="feature-toggle-row">
        <span class="toggle-copy">
          <strong>Allow for logged-in users</strong>
          <small>Authenticated users can enable Adult Mode in their settings.</small>
        </span>
        <span class="toggle-switch">
          <input type="checkbox" checked={adultPolicy.allowLoggedIn} disabled={adultPolicyLoading} onchange={() => toggleAdultPolicy('allowLoggedIn')} />
          <i aria-hidden="true"></i>
        </span>
      </label>
      <label class="feature-toggle-row">
        <span class="toggle-copy">
          <strong>Allow for users without login</strong>
          <small>Guest users can access Adult Mode. Requires server-side guest preference if no auth session exists.</small>
        </span>
        <span class="toggle-switch">
          <input type="checkbox" checked={adultPolicy.allowGuest} disabled={adultPolicyLoading} onchange={() => toggleAdultPolicy('allowGuest')} />
          <i aria-hidden="true"></i>
        </span>
      </label>
    </div>
  </AdminSection>
</AdminShell>

<style>
  .notice { display: flex; align-items: center; gap: 8px; margin-top: 12px; padding: 11px 13px; border-radius: var(--radius-sm); font-size: .72rem; color: var(--color-primary); border: 1px solid var(--color-primary-border); background: rgba(0, 255, 156, .06); }

  .hint { color: var(--color-text-deep); font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .56rem; letter-spacing: .04em; }

  .feature-toggles { display: grid; gap: 12px; margin-top: 4px; }
  .feature-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); background: var(--color-surface-elevated); cursor: pointer; }
  .toggle-copy { display: grid; gap: 4px; }
  .toggle-copy strong { color: var(--color-text); font-size: .8rem; font-weight: 700; }
  .toggle-copy small { color: var(--color-text-muted); font-size: .6rem; line-height: 1.5; }
  .toggle-switch { position: relative; width: 44px; height: 24px; flex-shrink: 0; }
  .toggle-switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
  .toggle-switch i { display: block; width: 100%; height: 100%; border-radius: 999px; background: var(--color-surface-raised); border: 1px solid var(--color-border-strong); transition: background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out); position: relative; }
  .toggle-switch i::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: var(--color-text); transition: transform var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out); }
  .toggle-switch input:checked ~ i { background: var(--color-primary); border-color: var(--color-primary-border); box-shadow: var(--glow-primary); }
  .toggle-switch input:checked ~ i::after { transform: translateX(20px); background: #050708; }
  .toggle-switch input:focus-visible ~ i { outline: 2px solid var(--color-focus); outline-offset: 2px; }

  @media (max-width: 640px) {
    .feature-toggle-row { flex-direction: column; align-items: flex-start; gap: 12px; }
  }
</style>
