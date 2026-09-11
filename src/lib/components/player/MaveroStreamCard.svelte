<script lang="ts">
  import { Check, Copy, Download } from 'lucide-svelte';
  import type { PlayerQualityOption } from '$lib/shared/player';
  import { formatMaveroStreamSize, maveroStreamDetailLabel, maveroStreamFormatLabel, maveroStreamQualityLabel, maveroStreamSubtitleLabel } from '$lib/client/player/mavero-streams';
  import { compatBadgeForStream } from '$lib/client/player/mavero-compat';
  import { copyStreamUrl, downloadAttributesFor } from '$lib/client/player/stream-actions';

  /**
   * Phase 9 — ONE rich MAVERO stream card (reusable presentational
   * component). Renders ONLY addon-supplied / reliably-derived metadata:
   * a missing field simply renders no chip (never an empty "Audio:" /
   * "Codec:" label). Every value is plain text interpolated by Svelte's
   * auto-escaping — no raw-HTML rendering, no `innerHTML`, no addon HTML anywhere.
   *
   * Mobile contract: 52px minimum touch target, addon titles/descriptions
   * truncate (CSS line-clamp + the helper-level 140-char cap), badges wrap
   * instead of overflowing.
   *
   * Phase 12 (GOAL H): two icon actions on the right — Copy URL and
   * Download — operating on the ORIGINAL addon stream URL (never the
   * compatibility/worker URL). Both stop propagation so an action click
   * never selects the stream.
   */

  export let stream: PlayerQualityOption;
  /** True while this stream is the live playing url (check + aria-selected). */
  export let selected = false;
  /** True when this stream URL already failed playback in this session. */
  export let failed = false;
  export let onselect: (stream: PlayerQualityOption) => void = () => {};

  $: badges = [
    ...(stream.audioLanguages ?? []),
    maveroStreamSubtitleLabel(stream),
    stream.codec,
    stream.container,
    maveroStreamFormatLabel(stream),
    formatMaveroStreamSize(stream.videoSize),
  ].filter((badge): badge is string => Boolean(badge));
  $: detail = maveroStreamDetailLabel(stream);
  // Phase 10 GOAL 11: compatibility hint badge — derived ONLY from the
  // addon-supplied metadata (shared classifier). `null` renders nothing;
  // uncertainty is phrased honestly ("May not play in this browser").
  $: compatBadge = compatBadgeForStream(stream);
  // Phase 12 (GOAL H): the download anchor attributes — built from the
  // ORIGINAL addon URL (the card never sees the worker/compat URL).
  $: downloadAttrs = downloadAttributesFor(stream);

  let copied = false;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  async function handleCopy() {
    // GOAL H: stopPropagation is bound on the element; the copy itself
    // uses the ORIGINAL addon URL (`stream.url`) — never the playing
    // worker session url or any transformed playback url.
    const result = await copyStreamUrl(stream.url);
    if (result === 'copied') {
      copied = true;
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => { copied = false; }, 2000);
    }
  }

  function handleDownload(event: MouseEvent) {
    // Native anchor navigation on the ORIGINAL addon URL — no proxy, no
    // transformation. Cross-origin servers may ignore the download hint.
    event.stopPropagation();
  }
</script>

<div
  class="mavero-stream-card"
  class:selected
  class:failed
>
  <button
    class="card-main"
    type="button"
    role="option"
    aria-selected={selected}
    onclick={() => onselect(stream)}
  >
    <span class="option-mark">{#if selected}<Check size={14} />{:else}<span></span>{/if}</span>
    <span class="card-body">
      <span class="card-title-row">
        <strong class="card-quality">{maveroStreamQualityLabel(stream)}</strong>
        {#if failed}<span class="card-failed" role="status">Failed — try another or retry</span>{/if}
      </span>
      {#if detail}<span class="card-detail">{detail}</span>{/if}
      {#if badges.length}
        <span class="card-badges">
          {#each badges as badge (badge)}
            <span class="card-badge">{badge}</span>
          {/each}
          {#if compatBadge}<span class="card-badge card-compat">{compatBadge}</span>{/if}
        </span>
      {:else if compatBadge}
        <span class="card-badges"><span class="card-badge card-compat">{compatBadge}</span></span>
      {/if}
    </span>
  </button>
  {#if stream.url}
    <span class="card-actions">
      <button
        class="card-action"
        class:done={copied}
        type="button"
        aria-label={copied ? 'Stream URL copied' : 'Copy stream URL'}
        title={copied ? 'Copied' : 'Copy URL'}
        onclick={(event) => { event.stopPropagation(); void handleCopy(); }}
      >
        {#if copied}<Check size={14} />{:else}<Copy size={14} />{/if}
        <span class="card-action-note" role="status">{copied ? 'Copied' : ''}</span>
      </button>
      {#if downloadAttrs}
        <!-- svelte-ignore a11y_missing_attribute -->
        <a
          class="card-action"
          href={downloadAttrs.href}
          download={downloadAttrs.download}
          target={downloadAttrs.target}
          rel={downloadAttrs.rel}
          aria-label="Download or open the original stream file"
          title="Download / open original file"
          onclick={handleDownload}
        ><Download size={14} /></a>
      {/if}
    </span>
  {/if}
</div>

<style>
  .mavero-stream-card { display: flex; align-items: flex-start; gap: 4px; width: 100%; min-height: 52px; border: 1px solid transparent; border-radius: var(--radius-sm); padding: 8px 6px 8px 0; color: var(--ink-soft); background: transparent; }
  .mavero-stream-card:hover, .mavero-stream-card:focus-within, .mavero-stream-card.selected { border-color: var(--line-strong); background: var(--accent-soft); }
  .mavero-stream-card.failed { opacity: 0.78; }
  .card-main { display: flex; align-items: flex-start; gap: 11px; flex: 1 1 auto; min-width: 0; min-height: 44px; padding: 0 0 0 12px; border: 0; color: inherit; background: transparent; cursor: pointer; text-align: left; font: inherit; }
  .card-body { display: grid; gap: 5px; min-width: 0; flex: 1 1 auto; }
  .card-title-row { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .card-quality { color: var(--ink); font-size: 0.72rem; flex: 0 0 auto; }
  .card-failed { overflow: hidden; color: var(--muted); font-size: 0.55rem; text-overflow: ellipsis; white-space: nowrap; }
  .card-detail { display: -webkit-box; overflow: hidden; color: var(--muted); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: 0.55rem; line-height: 1.45; word-break: break-word; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
  .card-badges { display: flex; flex-wrap: wrap; gap: 4px; }
  .card-badge { display: inline-flex; align-items: center; max-width: 100%; overflow: hidden; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; color: var(--ink-soft); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: 0.53rem; text-overflow: ellipsis; white-space: nowrap; }
  .card-compat { border-color: rgba(255, 176, 32, 0.45); color: #ffb020; }
  /* Phase 12 (GOAL H): compact icon actions, 38px touch targets. */
  .card-actions { display: flex; flex: 0 0 auto; flex-direction: column; gap: 2px; padding: 0 6px 0 2px; }
  .card-action { position: relative; display: grid; place-items: center; width: 38px; height: 38px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--ink-soft); background: rgba(255,255,255,.03); cursor: pointer; text-decoration: none; }
  .card-action:hover, .card-action:focus-visible { border-color: var(--line-strong); background: var(--accent-soft); color: var(--ink); }
  .card-action:active { transform: scale(.96); }
  .card-action.done { border-color: var(--accent); color: var(--accent); }
  .card-action-note { position: absolute; top: -14px; right: 0; color: var(--accent); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: .5rem; pointer-events: none; }
  @media (prefers-reduced-motion: reduce) { .mavero-stream-card, .card-action { transition: none; } }
</style>
