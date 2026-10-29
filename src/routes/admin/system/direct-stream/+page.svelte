<script lang="ts">
  /**
   * Admin 2.0 — DirectStream scraper workspace (2026-10 round 13).
   *
   * The admin page for the DirectStream VOD scraper. Owns the scraper CONFIG
   * (stored on app_config):
   *   * Embed domain — the vidsrc embed front domain (e.g. `https://vidsrc.to`).
   *     UPDATE THIS when vidsrc rotates its embed domain — no code change or
   *     redeploy needed.
   *   * CDN domains — the comma-separated CDN domains used to resolve the
   *     `{v1}`–`{v5}` placeholders (e.g. `cloudnestra.com`).
   *   * Enable/Disable toggle — the global on/off switch. When disabled, the
   *     resolver adapter throws SOURCE_DISABLED and falls back to the next
   *     source.
   *
   * The DirectStream streaming_source row itself is managed via the existing
   * Sources admin page (this page only manages the scraper CONFIG).
   *
   * WHY THIS PAGE EXISTS: scraper domains rotate frequently. Without this
   * page, every domain rotation would require a code change + redeploy. With
   * this page, the admin updates the domain in a form field and clicks Save —
   * the next scrape uses the new domain immediately.
   */

  import { enhance } from '$app/forms';
  import AdminAppShell from '$lib/components/admin2/AdminAppShell.svelte';
  import AdminPage from '$lib/components/admin2/AdminPage.svelte';
  import { Check, AlertCircle, Radar, ToggleLeft, ToggleRight, Globe, Server } from 'lucide-svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // svelte-ignore state_referenced_locally
  let embedDomain = $state(data.embedDomain ?? '');
  // svelte-ignore state_referenced_locally
  let cdnDomains = $state(data.cdnDomains ?? '');
  // svelte-ignore state_referenced_locally
  let scraperEnabled = $state(data.scraperEnabled ?? false);
  let toggleSaving = $state(false);

  // Re-prefill when the load invalidates (e.g. after a successful save
  // triggers an invalidateAll). Does NOT clobber an in-flight optimistic
  // toggle — the toggle handler sets toggleSaving=true, and we only sync
  // from server data when no toggle is pending.
  $effect(() => {
    embedDomain = data.embedDomain ?? '';
    cdnDomains = data.cdnDomains ?? '';
    if (!toggleSaving) {
      scraperEnabled = data.scraperEnabled ?? false;
    }
  });

  async function handleToggle() {
    if (toggleSaving) return;
    const previous = scraperEnabled;
    // OPTIMISTIC: flip the toggle immediately so the UI feels instant.
    // The server request runs in the background; on failure we revert.
    scraperEnabled = !previous;
    toggleSaving = true;
    try {
      const formData = new FormData();
      formData.set('enabled', String(!previous));
      const response = await fetch('?/toggleEnabled', { method: 'POST', body: formData });
      const result = await response.json();
      if (!result?.notice) {
        // Revert on failure.
        scraperEnabled = previous;
        if (result?.message) {
          alert(result.message);
        } else {
          alert('Could not toggle the scraper.');
        }
      }
      // On success, the optimistic value is now the truth — no revert.
      // The $effect will sync lastServerEnabled when invalidateAll fires.
    } catch {
      // Revert on network error.
      scraperEnabled = previous;
      alert('Network error while toggling the scraper.');
    }
    toggleSaving = false;
  }
</script>

<svelte:head>
  <title>DirectStream — Mavero Admin</title>
  <meta name="robots" content="noindex,nofollow" />
</svelte:head>

<AdminAppShell active="direct-stream">
  <AdminPage
    eyebrow="System"
    title="DirectStream"
    accent="cyan"
  >
    {#if form?.notice}
      <div class="a2-notice" role="status"><Check size={14} /> {form.notice}</div>
    {/if}
    {#if form?.message}
      <div class="a2-feature-error" role="alert"><AlertCircle size={14} /> {form.message}</div>
    {/if}

    <!-- ============================================================
         Scraper status + enable toggle
         ============================================================ -->
    <section class="a2-feature-section">
      <h3 class="a2-feature-section-title"><Radar size={14} /> Scraper Status</h3>
      <p class="a2-feature-hint">When enabled, the DirectStream source extracts real .m3u8 URLs from vidsrc and plays them through the Cloudflare Worker proxy. When disabled, the resolver skips this source and falls back to the next provider.</p>

      <div class="a2-feature-row">
        <div class="a2-feature-row-info">
          <span class="a2-feature-row-label">DirectStream Scraper</span>
          <span class="a2-feature-row-desc">{scraperEnabled ? 'Enabled — the scraper is active and the DirectStream source is eligible for playback.' : 'Disabled — the resolver skips this source and falls back to the next provider.'}</span>
        </div>
        <button type="button" class="a2-toggle" class:is-on={scraperEnabled} onclick={handleToggle} aria-pressed={scraperEnabled} aria-label="Toggle DirectStream scraper" aria-busy={toggleSaving}>
          {#if scraperEnabled}<ToggleRight size={24} />{:else}<ToggleLeft size={24} />{/if}
        </button>
      </div>
    </section>

    <!-- ============================================================
         Scraper config (embed domain + CDN domains)
         ============================================================ -->
    <section class="a2-feature-section">
      <h3 class="a2-feature-section-title"><Globe size={14} /> Scraper Domains</h3>
      <p class="a2-feature-hint">vidsrc rotates its domains frequently. When the scraper breaks, update these fields with the current domains and click Save — no code change or redeploy needed. The defaults are {data.defaultEmbedDomain} and {data.defaultCdnDomains}.</p>

      <form class="a2-links-form" method="POST" action="?/saveConfig" use:enhance={() => {
        return async ({ update }) => { await update({ reset: false }); };
      }}>
        <label class="a2-link-field">
          <span class="a2-link-label"><Globe size={13} /> Embed Domain</span>
          <input
            type="url"
            name="embed_domain"
            inputmode="url"
            placeholder={data.defaultEmbedDomain}
            value={embedDomain}
            autocomplete="off"
            spellcheck="false"
          />
          <span class="a2-link-hint">The vidsrc embed front domain (https only). Example: https://vidsrc.to</span>
        </label>

        <label class="a2-link-field">
          <span class="a2-link-label"><Server size={13} /> CDN Domains</span>
          <input
            type="text"
            name="cdn_domains"
            placeholder={data.defaultCdnDomains}
            value={cdnDomains}
            autocomplete="off"
            spellcheck="false"
          />
          <span class="a2-link-hint">Comma-separated list of CDN domains used to resolve the {`{v1}`}–{`{v5}`} placeholders. Example: cloudnestra.com,neonhorizonworkshops.com</span>
        </label>

        <div class="a2-form-actions">
          <button type="submit" class="a2-btn-primary">Save scraper config</button>
        </div>
      </form>
    </section>

    <!-- ============================================================
         How it works (info card)
         ============================================================ -->
    <section class="a2-feature-section">
      <h3 class="a2-feature-section-title"><Radar size={14} /> How It Works</h3>
      <ol class="a2-info-list">
        <li>The user selects the <strong>DirectStream</strong> source on a watch page.</li>
        <li>The resolver adapter calls the scraper module, which fetches the vidsrc embed page and follows the 3-hop chain: embed → RCP → prorcp.</li>
        <li>The scraper extracts the real <code>.m3u8</code> URL from the prorcp page's <code>file:</code> field and resolves the <code>{`{v1}`}</code>–<code>{`{v5}`}</code> placeholders to the configured CDN domains.</li>
        <li>The adapter wraps the m3u8 in a Cloudflare Worker proxy URL (with the required Referer baked in as <code>&amp;r=</code>). The browser cannot set Referer (it's a forbidden header), so the Worker adds it server-side.</li>
        <li>The existing HLS engine (hls.js) loads the proxied manifest and plays the stream. Quality levels and audio tracks are discovered dynamically from the manifest.</li>
      </ol>
      <p class="a2-feature-hint"><strong>Limitations:</strong> scraper reliability is low/medium — vidssrc rotates domains frequently. Subtitles from vidsrc are unreliable (often empty). The scraper runs server-side (no CORS issues); playback goes through the Worker (permissive CORS). vidsrc blocks VPN/proxy IPs — Netlify Functions run on AWS and may be blocked.</p>
    </section>
  </AdminPage>
</AdminAppShell>

<style>
  .a2-notice { display: inline-flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-green-soft); border: 1px solid var(--a2-green-border); border-radius: var(--a2-radius-sm); color: var(--a2-green); font-size: var(--a2-text-sm); margin-bottom: var(--a2-space-3); }
  .a2-feature-section { display: flex; flex-direction: column; gap: var(--a2-space-3); padding: var(--a2-space-4); background: var(--a2-surface-2); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-md); margin-bottom: var(--a2-space-4); }
  .a2-feature-section-title { display: inline-flex; align-items: center; gap: var(--a2-space-2); margin: 0 0 var(--a2-space-1) 0; font-size: var(--a2-text-sm); font-weight: 700; color: var(--a2-text-bright); }
  .a2-feature-hint { margin: 0 0 var(--a2-space-1) 0; font-size: var(--a2-text-2xs); color: var(--a2-text-muted); line-height: 1.5; }
  .a2-feature-error { display: inline-flex; align-items: center; gap: var(--a2-space-2); padding: var(--a2-space-2) var(--a2-space-3); background: var(--a2-red-soft); border: 1px solid var(--a2-red-border); border-radius: var(--a2-radius-sm); color: var(--a2-red); font-size: var(--a2-text-sm); margin-bottom: var(--a2-space-3); }
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
  .a2-link-hint { font-size: var(--a2-text-2xs); color: var(--a2-text-muted); }
  .a2-link-field input { background: var(--a2-surface-3); border: 1px solid var(--a2-border); border-radius: var(--a2-radius-sm); color: var(--a2-text); font-size: var(--a2-text-sm); padding: 8px 10px; min-height: 44px; }
  .a2-link-field input:focus { outline: none; border-color: var(--a2-cyan); }
  .a2-form-actions { display: flex; gap: var(--a2-space-2); justify-content: flex-end; padding-top: var(--a2-space-2); }
  .a2-btn-primary { padding: 10px 16px; background: var(--a2-cyan); color: var(--a2-surface-1); border: none; border-radius: var(--a2-radius-sm); font-size: var(--a2-text-sm); font-weight: 600; cursor: pointer; min-height: 44px; }
  .a2-btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
  .a2-info-list { margin: 0; padding-left: var(--a2-space-4); display: flex; flex-direction: column; gap: var(--a2-space-1); font-size: var(--a2-text-2xs); color: var(--a2-text-muted); line-height: 1.5; }
  .a2-info-list li { padding-left: var(--a2-space-1); }
  .a2-info-list code { background: var(--a2-surface-3); padding: 1px 4px; border-radius: var(--a2-radius-xs); font-size: var(--a2-text-2xs); color: var(--a2-text); }
  @keyframes a2-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .a2-toggle { transition: none; } }
</style>
