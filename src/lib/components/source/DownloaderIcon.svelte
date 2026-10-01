<script lang="ts">
  /**
   * Phase I (audit fix) — Canonical URL-based icon renderer.
   *
   * Renders a downloader/provider icon from a stored URL. Used by:
   *   - Admin Downloads list + edit form
   *   - User DownloadSheet
   *   - (Future) anywhere streaming_providers.icon is rendered
   *
   * Security:
   *   - The URL is validated at write time (validateIconUrl).
   *   - At render time, the URL is re-checked with isValidIconUrl.
   *     If it fails (tampered, legacy value, malformed), a safe
   *     fallback lucide icon is rendered — NEVER raw text or inline SVG.
   *   - The icon is rendered as `<img src="...">`, NOT innerHTML. SVG
   *     URLs are sandboxed by the browser's image loader — no script
   *     execution, no DOM access.
   *   - If the image fails to load (404, network error, CORS), the
   *     `onerror` handler swaps to the fallback lucide icon.
   *
   * CSP: the site's CSP must allow `img-src https: http:` for external
   * icon URLs. Most configs already do. If CSP is restrictive, the
   * `onerror` fallback ensures the UI still renders.
   */
  import { Download } from 'lucide-svelte';
  import { isValidIconUrl } from '$lib/shared/icon-url';

  let {
    icon = null as string | null,
    size = 20,
    alt = 'Provider icon',
  }: {
    icon?: string | null;
    size?: number;
    alt?: string;
  } = $props();

  // Track whether the image failed to load. If so, render the fallback.
  let failed = $state(false);

  // Re-derive when the icon prop changes (e.g. admin edits the field).
  // $derived would work but we need to reset `failed` too.
  $effect(() => {
    // Reset failed state when icon URL changes.
    failed = false;
  });

  const isValid = $derived(isValidIconUrl(icon));
</script>

{#if icon && isValid && !failed}
  <img
    src={icon}
    {alt}
    width={size}
    height={size}
    class="downloader-icon-img"
    loading="lazy"
    decoding="async"
    onerror={() => { failed = true; }}
  />
{:else}
  <span class="downloader-icon-fallback"><Download {size} aria-hidden="true" /></span>
{/if}

<style>
  .downloader-icon-img {
    display: inline-block;
    object-fit: contain;
    flex-shrink: 0;
    border-radius: 2px;
  }
  .downloader-icon-fallback {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    opacity: 0.7;
  }
</style>
