<script lang="ts">
  import { Check } from 'lucide-svelte';
  import type { PlayerQualityOption } from '$lib/shared/player';
  import { formatMaveroStreamSize, maveroStreamDetailLabel, maveroStreamFormatLabel, maveroStreamQualityLabel, maveroStreamSubtitleLabel } from '$lib/client/player/mavero-streams';
  import { compatBadgeForStream } from '$lib/client/player/mavero-compat';

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
   */

  export let stream: PlayerQualityOption;
  /** True while this stream is the live `mediaUrl` (check + aria-selected). */
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
</script>

<button
  class="mavero-stream-card"
  class:selected
  class:failed
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

<style>
  .mavero-stream-card { display: flex; align-items: flex-start; gap: 11px; width: 100%; min-height: 52px; border: 1px solid transparent; border-radius: var(--radius-sm); padding: 8px 12px; color: var(--ink-soft); background: transparent; cursor: pointer; text-align: left; }
  .mavero-stream-card:hover, .mavero-stream-card:focus-visible, .mavero-stream-card.selected { border-color: var(--line-strong); background: var(--accent-soft); }
  .mavero-stream-card.failed { opacity: 0.78; }
  .card-body { display: grid; gap: 5px; min-width: 0; flex: 1 1 auto; }
  .card-title-row { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .card-quality { color: var(--ink); font-size: 0.72rem; flex: 0 0 auto; }
  .card-failed { overflow: hidden; color: var(--muted); font-size: 0.55rem; text-overflow: ellipsis; white-space: nowrap; }
  .card-detail { display: -webkit-box; overflow: hidden; color: var(--muted); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: 0.55rem; line-height: 1.45; word-break: break-word; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
  .card-badges { display: flex; flex-wrap: wrap; gap: 4px; }
  .card-badge { display: inline-flex; align-items: center; max-width: 100%; overflow: hidden; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; color: var(--ink-soft); font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; font-size: 0.53rem; text-overflow: ellipsis; white-space: nowrap; }
  .card-compat { border-color: rgba(255, 176, 32, 0.45); color: #ffb020; }
  @media (prefers-reduced-motion: reduce) { .mavero-stream-card { transition: none; } }
</style>
