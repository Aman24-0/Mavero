<script lang="ts">
  import { onMount } from 'svelte';
  import { AlertTriangle, Download, Info, Loader2, Share2, Check } from 'lucide-svelte';
  import { downloadAttributesFor } from '$lib/client/player/stream-actions';

  /**
   * 4K Downloader — the downloads.shegu.st JSON API result panel (Phase 19).
   *
   * Rendered inside the DownloadSheet when the "4K Downloader" provider is
   * selected (recognized by slug '4k-downloader'). Fetches /api/downloader/4k
   * which proxies the JSON API server-side (avoids client-side CORS).
   *
   * Each 4K result card shows ONLY:
   *   1. Title (the movie/series title)
   *   2. Format (derived from the API link name — e.g. "WEB-DL DDP5")
   *   3. Quality (derived from the API link name — e.g. "2160p")
   *   4. Size (derived from the API link name — e.g. "16.62 GB")
   *   5. Download button (uses the EXACT returned URL)
   *   6. Share button (shares the EXACT returned URL via navigator.share)
   *
   * The media URL is NEVER rewritten, proxied, or transformed. No FFmpeg,
   * no media-worker. Download + Share operate on the EXACT returned URL.
   */

  export let tmdbId = '';
  export let mediaType: 'movie' | 'series' | 'anime' = 'movie';
  export let season: number | undefined = undefined;
  export let episode: number | undefined = undefined;
  export let title = '';

  type FourKLinkView = {
    url: string;
    name: string;
    format: string | undefined;
    quality: string | undefined;
    size: string | undefined;
  };

  let links: FourKLinkView[] = [];
  let loading = true;
  let failed = false;

  // Share action state.
  let shareKey = '';
  let shareState: 'sharing' | 'shared' | 'failed' | '' = '';
  let shareTimer: ReturnType<typeof setTimeout> | undefined;

  // Download action state.
  let openingKey = '';
  let openingTimer: ReturnType<typeof setTimeout> | undefined;

  function buildParams(): URLSearchParams {
    const params = new URLSearchParams({ tmdbId, mediaType });
    if (season !== undefined) params.set('season', String(season));
    if (episode !== undefined) params.set('episode', String(episode));
    return params;
  }

  async function load(): Promise<void> {
    loading = true;
    failed = false;
    try {
      const response = await fetch(`/api/downloader/4k?${buildParams().toString()}`, { headers: { accept: 'application/json' } });
      const payload = await response.json() as { ok?: boolean; links?: FourKLinkView[] };
      if (!response.ok || !payload.ok) throw new Error('unavailable');
      links = payload.links ?? [];
      failed = false;
    } catch (error) {
      failed = true;
      links = [];
      console.warn('[4KDownloader] fetch failed', error);
    } finally {
      loading = false;
    }
  }

  function shareTitle(link: FourKLinkView): string {
    const fromName = link.name || title;
    if (fromName && fromName.trim()) return fromName.trim().slice(0, 120);
    return title || '4K Download';
  }

  async function handleShare(link: FourKLinkView, key: string): Promise<void> {
    if (shareKey === key && shareState === 'sharing') return;
    const url = link.url; // the EXACT returned URL
    if (!url) return;
    shareKey = key;
    shareState = 'sharing';
    if (shareTimer) clearTimeout(shareTimer);
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        await navigator.share({ title: shareTitle(link), url });
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

  onMount(load);
</script>

<div class="fk" aria-busy={loading}>
  {#if loading}
    <div class="fk-state" role="status"><span class="fk-spin"><Loader2 size={16} /></span><span>Fetching 4K links…</span></div>
  {:else if failed}
    <div class="fk-state fk-state-error" role="status">
      <AlertTriangle size={16} />
      <span>Couldn't load 4K links.</span>
      <button type="button" class="fk-retry" onclick={load}>Retry</button>
    </div>
  {:else if links.length === 0}
    <div class="fk-state" role="status"><Info size={16} /><span>No 4K links found for this title.</span></div>
  {:else}
    <div class="fk-list" role="list" aria-label="4K download links">
      {#each links as link, index (link.url + '-' + index)}
        {@const key = `4k-${index}`}
        <article class="fk-row" role="listitem">
          <div class="fk-row-main">
            {#if title}<span class="fk-row-title">{title}</span>{/if}
            <span class="fk-row-meta">
              {#if link.format}{link.format}{/if}
              {#if link.quality} · {link.quality}{/if}
              {#if link.size} · {link.size}{/if}
            </span>
          </div>
          <div class="fk-row-actions">
            <a
              class="fk-action"
              class:opening={openingKey === key}
              href={link.url}
              download={downloadAttributesFor({ url: link.url, filename: link.name })?.download ?? '4k-download'}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={openingKey === key ? 'Opening the 4K file' : 'Download the 4K file'}
              title="Download (original URL)"
              onclick={(event) => handleDownload(event, key)}
            ><Download size={13} /></a>
            <button
              class="fk-action fk-action-share"
              class:done={shareKey === key && shareState === 'shared'}
              class:failed={shareKey === key && shareState === 'failed'}
              type="button"
              aria-label={shareKey === key && shareState === 'shared' ? 'URL shared' : shareKey === key && shareState === 'failed' ? 'Share failed' : 'Share original URL'}
              title="Share (original URL)"
              onclick={(event) => { event.stopPropagation(); void handleShare(link, key); }}
            >
              {#if shareKey === key && shareState === 'sharing'}<Loader2 size={13} class="fk-spin" />
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
  .fk { display: flex; flex-direction: column; gap: 6px; min-height: 200px; color: var(--ink); }
  .fk-state { display: flex; min-height: 120px; flex: 1 1 auto; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap; padding: 8px; color: var(--muted); font-size: 0.66rem; text-align: center; }
  .fk-state-error { color: #d48a64; }
  .fk-retry { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--accent-soft); color: var(--ink); padding: 4px 10px; font: inherit; font-size: 0.62rem; font-weight: 700; cursor: pointer; }
  .fk-retry:hover { border-color: var(--accent); color: var(--accent); }
  .fk-spin { display: grid; place-items: center; animation: fk-spin 0.9s linear infinite; }
  .fk-list { display: flex; flex-direction: column; gap: 4px; flex: 1 1 auto; overflow-y: auto; scrollbar-width: thin; min-height: 0; }
  .fk-list::-webkit-scrollbar { width: 3px; }
  .fk-list::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 2px; }
  .fk-row { display: flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: rgba(255, 255, 255, 0.025); padding: 6px 8px; }
  .fk-row-main { display: flex; flex: 1 1 auto; flex-direction: column; gap: 2px; min-width: 0; }
  .fk-row-title { overflow: hidden; color: var(--ink); font-size: 0.64rem; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
  .fk-row-meta { overflow: hidden; color: var(--muted); font-size: 0.58rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .fk-row-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 4px; }
  .fk-action { position: relative; display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--ink-soft); background: rgba(255, 255, 255, 0.03); cursor: pointer; text-decoration: none; flex: 0 0 auto; }
  .fk-action:hover, .fk-action:focus-visible { border-color: var(--line-strong); background: var(--accent-soft); color: var(--ink); }
  .fk-action:active { transform: scale(0.96); }
  .fk-action.done { border-color: var(--accent); color: var(--accent); }
  .fk-action.failed { border-color: #d48a64; color: #d48a64; }
  .fk-action.opening { border-color: var(--accent); color: var(--accent); opacity: 0.7; pointer-events: none; }
  .fk-action-share { color: var(--ink); }
  @keyframes fk-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .fk-spin { animation: none; } .fk-action { transition: none; } }
</style>
