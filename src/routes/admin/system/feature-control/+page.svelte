<script lang="ts">
  /**
   * Admin 2.0 — Feature Control workspace.
   *
   * Independent route (extracted from the legacy /admin/system/content-rules
   * "Feature Control" tab + consolidated with the community-links UI that
   * used to live at /admin/system/app-config). Owns TWO feature groups on a
   * single page:
   *
   *   1. Adult Mode policy — server-enforced gates that control who can
   *      access adult content. Reads/writes through the existing
   *      /api/admin/adult-mode endpoint (no API surface changed).
   *
   *   2. Community invite links — Telegram + Discord invite URLs stored on
   *      the single-row `app_config` table (telegram_url, discord_url).
   *      Reads through the shared getAppConfig() helper; writes through
   *      the ?/saveSocial form action on this route. Empty value = unset
   *      (the public UI hides the chip).
   *
   * No verbose description text under the title — the section headings +
   * inline hints are enough (Admin UI de-clutter round).
   */

  import { onMount } from 'svelte';
  import { enhance } from '$app/forms';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import AdminFormSection from '$lib/components/admin/AdminFormSection.svelte';
  import { ShieldCheck, Check, AlertCircle, Loader2, ToggleLeft, ToggleRight, Link2, Send, MessageCircle } from 'lucide-svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // ============================================================
  // Adult Mode policy (loaded client-side via /api/admin/adult-mode —
  // preserves the existing partial-load behavior; nothing else changed).
  // ============================================================
  let adultPolicy = $state<{ allowLoggedIn: boolean; allowGuest: boolean } | null>(null);
  let adultPolicyLoading = $state(false);
  let adultPolicySaving = $state(false);
  let adultPolicyError = $state<string | null>(null);
  let adultPolicySuccess = $state<string | null>(null);

  async function loadAdultPolicy() {
    adultPolicyLoading = true;
    adultPolicyError = null;
    try {
      const res = await fetch('/api/admin/adult-mode');
      const json = await res.json();
      if (json.ok) {
        adultPolicy = { allowLoggedIn: Boolean(json.policy?.allowLoggedIn), allowGuest: Boolean(json.policy?.allowGuest) };
      } else {
        adultPolicyError = json.error?.message ?? 'Failed to load feature policies.';
      }
    } catch { adultPolicyError = 'Network error while loading feature policy.'; }
    adultPolicyLoading = false;
  }

  async function togglePolicy(key: 'allowLoggedIn' | 'allowGuest') {
    if (!adultPolicy || adultPolicySaving) return;
    adultPolicySaving = true;
    adultPolicyError = null;
    adultPolicySuccess = null;
    const newPolicy = { ...adultPolicy, [key]: !adultPolicy[key] };
    try {
      const res = await fetch('/api/admin/adult-mode', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newPolicy) });
      const json = await res.json();
      if (json.ok) { adultPolicy = newPolicy; adultPolicySuccess = 'Feature policy updated.'; }
      else { adultPolicyError = json.error?.message ?? 'Failed to update.'; }
    } catch { adultPolicyError = 'Network error.'; }
    adultPolicySaving = false;
  }

  // ============================================================
  // Community invite links (Telegram + Discord). Prefilled from the
  // server load; saved through the ?/saveSocial form action on this
  // route (same storage as the rest of the app: app_config table).
  // ============================================================
  // svelte-ignore state_referenced_locally
  let telegramUrl = $state(data.telegramInviteUrl ?? '');
  // svelte-ignore state_referenced_locally
  let discordUrl = $state(data.discordInviteUrl ?? '');

  // Re-prefill when the load invalidates (e.g. after a successful save
  // triggers an invalidateAll).
  $effect(() => {
    telegramUrl = data.telegramInviteUrl ?? '';
    discordUrl = data.discordInviteUrl ?? '';
  });

  onMount(() => { void loadAdultPolicy(); });
</script>

<svelte:head>
  <title>Feature Control — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell active="feature-control">
  <AdminPage
    eyebrow="System"
    title="Feature Control"
    accent="cyan"
  >
    {#if adultPolicySuccess}
      <div class="a2-notice" role="status"><Check size={14} /> {adultPolicySuccess}</div>
    {/if}
    {#if form?.notice}
      <div class="a2-notice" role="status"><Check size={14} /> {form.notice}</div>
    {/if}

    <!-- ============================================================
         Adult Mode Policy
         ============================================================ -->
    <section class="a2-feature-section">
      <h3 class="a2-feature-section-title"><ShieldCheck size={14} /> Adult Mode Policy</h3>

      {#if adultPolicyLoading}
        <div class="a2-feature-loading" role="status"><Loader2 size={16} style="animation: a2-spin 1s linear infinite; color: var(--a2-cyan);" /> <span>Loading…</span></div>
      {:else if adultPolicyError}
        <div class="a2-feature-error" role="alert"><AlertCircle size={14} /> {adultPolicyError} <button type="button" class="a2-feature-retry" onclick={loadAdultPolicy}>Retry</button></div>
      {:else if adultPolicy}
        <div class="a2-feature-row">
          <div class="a2-feature-row-info"><span class="a2-feature-row-label">Allow logged-in users</span><span class="a2-feature-row-desc">Authenticated users can access adult content. Enforced server-side.</span></div>
          <button type="button" class="a2-toggle" class:is-on={adultPolicy.allowLoggedIn} onclick={() => togglePolicy('allowLoggedIn')} disabled={adultPolicySaving} aria-pressed={adultPolicy.allowLoggedIn} aria-label="Toggle allow logged-in">
            {#if adultPolicy.allowLoggedIn}<ToggleRight size={24} />{:else}<ToggleLeft size={24} />{/if}
          </button>
        </div>
        <div class="a2-feature-row">
          <div class="a2-feature-row-info"><span class="a2-feature-row-label">Allow guests</span><span class="a2-feature-row-desc">Unauthenticated visitors can access adult content. Enforced server-side.</span></div>
          <button type="button" class="a2-toggle" class:is-on={adultPolicy.allowGuest} onclick={() => togglePolicy('allowGuest')} disabled={adultPolicySaving} aria-pressed={adultPolicy.allowGuest} aria-label="Toggle allow guests">
            {#if adultPolicy.allowGuest}<ToggleRight size={24} />{:else}<ToggleLeft size={24} />{/if}
          </button>
        </div>
      {/if}
    </section>

    <!-- ============================================================
         Community invite links (Telegram + Discord)
         ============================================================ -->
    <section class="a2-feature-section">
      <h3 class="a2-feature-section-title"><Link2 size={14} /> Community Invite Links</h3>
      <p class="a2-feature-hint">Shown in the footer and the Account menu. Leave a field empty to hide that icon; leave both empty to hide the whole row.</p>

      {#if form?.message}
        <div class="a2-feature-error" role="alert"><AlertCircle size={14} /> {form.message}</div>
      {/if}

      <form class="a2-links-form" method="POST" action="?/saveSocial" use:enhance={() => {
        return async ({ update }) => { await update({ reset: false }); };
      }}>
        <label class="a2-link-field">
          <span class="a2-link-label"><Send size={13} /> Telegram URL</span>
          <input
            type="url"
            name="telegram_url"
            inputmode="url"
            placeholder="https://t.me/your-channel"
            value={telegramUrl}
            autocomplete="off"
            spellcheck="false"
          />
        </label>

        <label class="a2-link-field">
          <span class="a2-link-label"><MessageCircle size={13} /> Discord URL</span>
          <input
            type="url"
            name="discord_url"
            inputmode="url"
            placeholder="https://discord.gg/your-server"
            value={discordUrl}
            autocomplete="off"
            spellcheck="false"
          />
        </label>

        <div class="a2-form-actions">
          <button type="submit" class="a2-btn-primary">Save social links</button>
        </div>
      </form>
    </section>
  </AdminPage>
</AdminAppShell>

<style>
  .a2-notice { display: inline-flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-green-soft); border: 1px solid var(--a2-green-border); border-radius: var(--a2-radius-sm); color: var(--a2-green); font-size: var(--a2-text-sm); margin-bottom: var(--a2-space-3); }
  .a2-feature-section { display: flex; flex-direction: column; gap: var(--a2-space-3); padding: var(--a2-space-4); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); margin-bottom: var(--a2-space-4); }
  .a2-feature-section-title { display: inline-flex; align-items: center; gap: var(--a2-space-2); margin: 0 0 var(--a2-space-1) 0; font-size: var(--a2-text-sm); font-weight: 700; color: var(--a2-text-bright); }
  .a2-feature-hint { margin: 0 0 var(--a2-space-1) 0; font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }
  .a2-feature-loading { display: inline-flex; align-items: center; gap: var(--a2-space-2); color: var(--a2-text-muted); }
  .a2-feature-error { display: inline-flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-sm); color: var(--a2-red); font-size: var(--a2-text-sm); }
  .a2-feature-retry { padding: 8px 12px; background: var(--a2-surface-3); border: 1px solid var(--a2-border-strong); border-radius: var(--a2-radius-xs); color: var(--a2-text); font-size: var(--a2-text-2xs); cursor: pointer; min-height: 44px; }
  .a2-feature-row { display: flex; justify-content: space-between; align-items: center; gap: var(--a2-space-4); padding: var(--a2-space-3) var(--a2-space-4); background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); }
  .a2-feature-row-info { display: flex; flex-direction: column; gap: 2px; }
  .a2-feature-row-label { font-size: var(--a2-text-sm); font-weight: 600; color: var(--a2-text-bright); }
  .a2-feature-row-desc { font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }
  .a2-toggle { background: transparent; border: none; cursor: pointer; color: var(--a2-text-dim); min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; }
  .a2-toggle.is-on { color: var(--a2-green); }
  .a2-toggle:disabled { opacity: 0.5; }
  .a2-links-form { display: flex; flex-direction: column; gap: var(--a2-space-3); }
  .a2-link-field { display: flex; flex-direction: column; gap: 4px; }
  .a2-link-label { display: inline-flex; align-items: center; gap: var(--a2-space-1); font-size: var(--a2-text-2xs); color: var(--a2-text-dim); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .a2-link-field input { background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-sm); padding: 8px 10px; min-height: 44px; }
  .a2-link-field input:focus { outline: none; border-color: var(--a2-cyan); }
  .a2-form-actions { display: flex; gap: var(--a2-space-2); justify-content: flex-end; padding-top: var(--a2-space-2); }
  .a2-btn-primary { padding: 10px 16px; background: var(--a2-cyan); color: var(--a2-surface-1); border: none; border-radius: var(--a2-radius-sm); font-size: var(--a2-text-sm); font-weight: 600; cursor: pointer; min-height: 44px; }
  .a2-btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
  @keyframes a2-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .a2-toggle { transition: none; } }
</style>
