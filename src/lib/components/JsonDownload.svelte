<script lang="ts">
  import { AlertTriangle, Download, Info, Loader2, Share2, Check } from 'lucide-svelte';
  import { downloadAttributesFor } from '$lib/client/player/stream-actions';
  import type { DownloadMediaType } from '$lib/shared/downloader';

  /**
   * Generic JSON downloader panel — rendered inside the DownloadSheet for
   * every provider whose registry `type` is 'json' (and which is NOT one of
   * the slug-special-cased providers).
   *
   * The component NEVER receives a raw provider URL from the browser. It
   * identifies the provider (id) + media context to the server endpoint
   * /api/downloader/json, which resolves the ADMIN-CONFIGURED template,
   * fetches the JSON API server-side (SSRF-safe), and returns ONLY the
   * normalized link list.
   *
   * States: loading / error + retry / empty (no compatible links) / list.
   *
   * Each result shows the metadata the API supplied (server/source, quality,
   * size, title — gracefully omitted when absent) plus:
   *   * Download/Open — uses the EXACT returned URL (never rewritten,
   *     proxied, transformed, scraped, or iframed). Magnet URIs open through
   *     the OS magnet handler (anchor href), exactly like the Mavero
   *     Downloader panel.
   *   * Share — the EXACT returned URL via navigator.share / clipboard.
   *
   * Styling mirrors the compact FourKDownload rows (jd-* classes, the same
   * CSS custom properties) so both JSON panels look identical.
   */

  export let providerId = '';
  export let providerName = '';
  export let mediaType: DownloadMediaType = 'movie';
  export let tmdbId = '';
  export let season: number | undefined = undefined;
  export let episode: number | undefined = undefined;
  export let title = '';

  type JsonLinkView = {
    url: string;
    title?: string;
    server?: string;
    source?: string;
    quality?: string;
    size?: string;
  };

  let links: JsonLinkView[] = [];
  let loading = true;
  let failed = false;

  // Share action state (per-row state machine, mirrors FourKDownload).
  let shareKey = '';
  let shareState: 'sharing' | 'shared' | 'failed' | '' = '';
  let shareTimer: ReturnType<typeof setTimeout> | undefined;

  // Download action state.
  let openingKey = '';
  let openingTimer: ReturnType<typeof setTimeout> | undefined;

  // The parent passes the ORIGINAL app content type ('movie' | 'series' |
  // 'anime') when it differs from the registry-shaped mediaType, so the
  // server's adult guard classifies the title through the canonical
  // pipeline (preserves the anime classification, like the 4K endpoint).
  export let contentType: 'movie' | 'series' | 'anime' | '' = '';

  function buildParams(): URLSearchParams {
    const params = new URLSearchParams({ providerId, mediaType, tmdbId });
    if (contentType) params.set('contentType', contentType);
    if (season !== undefined) params.set('season', String(season));
    if (episode !== undefined) params.set('episode', String(episode));
    return params;
  }

  async function load(): Promise<void> {
    if (!providerId || !tmdbId) {
      loading = false;
      failed = true;
      return;
    }
    loading = true;
    failed = false;
    try {
      const response = await fetch(`/api/downloader/json?${buildParams().toString()}`, { headers: { accept: 'application/json' } });
      const payload = await response.json() as { ok?: boolean; links?: JsonLinkView[] };
      if (!response.ok || !payload.ok) throw new Error('unavailable');
      links = payload.links ?? [];
      failed = false;
    } catch (error) {
      failed = true;
      links = [];
      console.warn('[JsonDownloader] fetch failed', error);
    } finally {
      loading = false;
    }
  }

  // Re-fetch when the request identity changes (the sheet stays mounted
  // while the user switches between json providers or episodes — the
  // component must follow the new context, not keep stale links).
  let requestToken = '';
  $: requestKey = `${providerId}|${mediaType}|${tmdbId}|${season ?? ''}|${episode ?? ''}`;
  $: if (requestKey && requestKey !== requestToken) {
    requestToken = requestKey;
    void load();
  }

  /** The first line of a row: the link's own title, else the server/source. */
  function rowHeadline(link: JsonLinkView): string {
    return link.title || link.server || link.source || '';
  }

  /** The compact metadata line: server · source · quality · size. */
  function rowMeta(link: JsonLinkView): string {
    const parts: string[] = [];
    if (link.server) parts.push(link.server);
    if (link.source && link.source !== link.server) parts.push(link.source);
    if (link.quality) parts.push(link.quality);
    if (link.size) parts.push(link.size);
    return parts.join(' · ');
  }

  function isMagnet(url: string): boolean {
    return url.toLowerCase().startsWith('magnet:');
  }

  function shareTitle(link: JsonLinkView): string {
    const fromLink = link.title || link.server || title;
    if (fromLink && fromLink.trim()) return fromLink.trim().slice(0, 120);
    return title || providerName || 'Download link';
  }

  async function handleShare(link: JsonLinkView, key: string): Promise<void> {
    if (shareKey === key && shareState === 'sharing') return;
    const url = link.url; // the EXACT returned URL
    if (!url) return;
    shareKey = key;
    shareState = 'sharing';
    if (shareTimer) clearTimeout(shareTimer);
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        // navigator.share({ url }) can FAIL for non-http(s) URIs (magnet:?…)
        // — for those use the universally accepted text field instead
        // (same fix as the Mavero Downloader panel, Phase 20 §4).
        if (isMagnet(url)) {
          await navigator.share({ title: shareTitle(link), text: url });
        } else {
          await navigator.share({ title: shareTitle(link), url });
        }
        shareState = 'shared';
      } else if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(url);
        shareState = 'shared';
      } else {
        const copied = legacyCopy(url);
        shareState = copied ? 'shared' : 'failed';
      }
    } catch (error) {
      if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'NotAllowedError')) {
        shareState = '';
      } else {
        shareState = 'failed';
      }
    } finally {
      if (shareState === 'shared' || shareState === 'failed') {
        shareTimer = setTimeout(() => { shareKey = ''; shareState = ''; }, 2000);
      } else if (shareState === '') {
        shareKey = '';
      }
    }
  }

  function legacyCopy(url: string): boolean {
    if (typeof document === 'undefined') return false;
    try {
      const textarea = document.createElement('textarea');
      textarea.value = url;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      return copied;
    } catch {
      return false;
    }
  }

  function handleDownload(event: MouseEvent, key: string) {
    event.stopPropagation();
    if (openingKey) return;
    openingKey = key;
    if (openingTimer) clearTimeout(openingTimer);
    openingTimer = setTimeout(() => { openingKey = ''; }, 2500);
  }
</script>

<div class="jd" aria-busy={loading}>
  {#if loading}
    <div class="jd-state" role="status"><span class="jd-spin"><Loader2 size={16} /></span><span>Fetching download links…</span></div>
  {:else if failed}
    <div class="jd-state jd-state-error" role="status">
      <AlertTriangle size={16} />
      <span>Couldn't load links{providerName ? ` from ${providerName}` : ''}.</span>
      <button type="button" class="jd-retry" onclick={load}>Retry</button>
    </div>
  {:else if links.length === 0}
    <div class="jd-state" role="status"><Info size={16} /><span>No download links found for this title.</span></div>
  {:else}
    <div class="jd-list" role="list" aria-label="Download links">
      {#each links as link, index (link.url + '-' + index)}
        {@const key = `jd-${index}`}
        {@const attrs = downloadAttributesFor({ url: link.url, filename: link.title })}
        <article class="jd-row" role="listitem">
          <div class="jd-row-main">
            {#if rowHeadline(link)}<span class="jd-row-title">{rowHeadline(link)}</span>{/if}
            {#if rowMeta(link)}
              <span class="jd-row-meta">{rowMeta(link)}</span>
            {:else if !rowHeadline(link)}
              <span class="jd-row-meta jd-row-url">{link.url}</span>
            {/if}
          </div>
          <div class="jd-row-actions">
            {#if attrs}
              <a
                class="jd-action"
                class:opening={openingKey === key}
                href={attrs.href}
                download={attrs.download}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={openingKey === key ? 'Opening the file' : 'Download the file'}
                title="Download (original URL)"
                onclick={(event) => handleDownload(event, key)}
              ><Download size={13} /></a>
            {:else}
              <!-- Magnet/P2P — direct anchor to the magnet URI; the OS
                   resolves it through the configured torrent app (same
                   external-open flow as the Mavero Downloader panel). -->
              <a
                class="jd-action"
                class:opening={openingKey === key}
                href={link.url}
                aria-label={openingKey === key ? 'Opening the magnet link' : 'Open the magnet link'}
                title="Open (original magnet URI)"
                onclick={(event) => handleDownload(event, key)}
              ><Download size={13} /></a>
            {/if}
            <button
              class="jd-action jd-action-share"
              class:done={shareKey === key && shareState === 'shared'}
              class:failed={shareKey === key && shareState === 'failed'}
              type="button"
              aria-label={shareKey === key && shareState === 'shared' ? 'URL shared' : shareKey === key && shareState === 'failed' ? 'Share failed' : 'Share original URL'}
              title="Share (original URL)"
              onclick={(event) => { event.stopPropagation(); void handleShare(link, key); }}
            >
              {#if shareKey === key && shareState === 'sharing'}<Loader2 size={13} class="jd-spin" />
              {:else if shareKey === key && shareState === 'shared'}<Check size={13} />
              {:else if shareKey === key && shareState === 'failed'}<AlertTriangle size={13} />
              {:else}<Share2 size={13} />{/if}
            </button>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</div>

<style>
  .jd { display: flex; flex-direction: column; gap: 6px; min-height: 200px; color: var(--ink); }
  .jd-state { display: flex; min-height: 120px; flex: 1 1 auto; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap; padding: 8px; color: var(--muted); font-size: 0.66rem; text-align: center; }
  .jd-state-error { color: #d48a64; }
  .jd-retry { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--accent-soft); color: var(--ink); padding: 4px 10px; font: inherit; font-size: 0.62rem; font-weight: 700; cursor: pointer; }
  .jd-retry:hover { border-color: var(--accent); color: var(--accent); }
  .jd-spin { display: grid; place-items: center; animation: jd-spin 0.9s linear infinite; }
  .jd-list { display: flex; flex-direction: column; gap: 4px; flex: 1 1 auto; overflow-y: auto; scrollbar-width: thin; min-height: 0; }
  .jd-list::-webkit-scrollbar { width: 3px; }
  .jd-list::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 2px; }
  .jd-row { display: flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: rgba(255, 255, 255, 0.025); padding: 6px 8px; }
  .jd-row-main { display: flex; flex: 1 1 auto; flex-direction: column; gap: 2px; min-width: 0; }
  .jd-row-title { overflow: hidden; color: var(--ink); font-size: 0.64rem; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
  .jd-row-meta { overflow: hidden; color: var(--muted); font-size: 0.58rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .jd-row-url { font-family: 'JetBrains Mono', ui-monospace, monospace; direction: rtl; text-align: left; }
  .jd-row-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 4px; }
  .jd-action { position: relative; display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--ink-soft); background: rgba(255, 255, 255, 0.03); cursor: pointer; text-decoration: none; flex: 0 0 auto; }
  .jd-action:hover, .jd-action:focus-visible { border-color: var(--line-strong); background: var(--accent-soft); color: var(--ink); }
  .jd-action:active { transform: scale(0.96); }
  .jd-action.done { border-color: var(--accent); color: var(--accent); }
  .jd-action.failed { border-color: #d48a64; color: #d48a64; }
  .jd-action.opening { border-color: var(--accent); color: var(--accent); opacity: 0.7; pointer-events: none; }
  .jd-action-share { color: var(--ink); }
  @keyframes jd-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .jd-spin { animation: none; } .jd-action { transition: none; } }
</style>
