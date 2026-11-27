<script lang="ts">
  // Round 51 (approved concept, Phase 3 — series context): the paused Up-next
  // card. Round 52 (F4): extracted into ONE shared component with TWO anchor
  // variants so the SAME card renders in both of its contexts:
  //   * variant="zone"  (default) — inside the paused zone: the while-paused
  //     card anchored to the zone's bottom-right; in portrait it joins the
  //     zone's column-reverse stack (position: static) exactly as before.
  //   * variant="auto"  — the AUTO card while PLAYING within 180 s of the
  //     end of a series episode: a floating bottom-right overlay ABOVE the
  //     bottom bar (never shifts the timeline), rendered by PlayerControls
  //     OUTSIDE the playing-gated zones so it shows with the normal chrome.
  // The Play button mirrors the Resume pill and switches via the shell's
  // EXISTING episode-change path; absent → no button. The 16:9 still is a
  // FIXED aspect box (aspect-ratio + object-fit cover, lazy) so the image can
  // never shift the layout (no CLS); a missing still renders nothing — never
  // fabricated.
  import { Play } from 'lucide-svelte';

  export let upNext: { still: string; title: string; season: number; episode: number };
  export let onUpNext: (() => void) | null = null;
  /** 'zone' = paused-zone anchor (portrait stacks in the zone); 'auto' = floating above the bottom bar. */
  export let variant: 'zone' | 'auto' = 'zone';
</script>

<div class="upnext-card" class:auto={variant === 'auto'} role="complementary" aria-label={`Up next: ${upNext.title || `Season ${upNext.season}, Episode ${upNext.episode}`}`}>
  {#if upNext.still}
    <div class="upnext-still"><img src={upNext.still} alt="" loading="lazy" /></div>
  {/if}
  <span class="upnext-label">UP NEXT</span>
  {#if upNext.title}<div class="upnext-title">{upNext.title}</div>{/if}
  <div class="upnext-ep">S{upNext.season} · E{String(upNext.episode).padStart(2, '0')}</div>
  {#if onUpNext}
    <button class="upnext-play" type="button" aria-label={`Play ${upNext.title || `episode ${upNext.episode}`}`} onclick={onUpNext}>
      <Play size={14} fill="currentColor" aria-hidden="true" />
      <span>Play</span>
    </button>
  {/if}
</div>

<style>
  /* Round 51 (Phase 3): the card's shape — accent rule, 280px column. The
     ZONE variant anchors absolutely inside the paused zone (right/bottom of
     the zone); portrait turns it static inside the zone's column stack
     (PlayerControls' zone contract, kept below). */
  .upnext-card {
    position: absolute;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 280px;
    max-height: 100%;
    overflow: hidden;
    padding: 6px 14px 6px 16px;
    border-left: 4px solid #fff;
    animation: paused-card-in 140ms var(--pl-ease, cubic-bezier(0.2, 0.8, 0.2, 1));
  }
  /* Round 52 (F4) — the AUTO variant: while PLAYING near the end the card
     floats at the shell's bottom-right ABOVE the bottom bar (an absolute
     overlay — it never shifts the timeline; the bar keeps its space). The
     offset clears the bar's tallest layout (base 88px) with breathing room;
     compact/landscape blocks below tighten it to their shorter bars. */
  .upnext-card.auto {
    right: max(16px, env(safe-area-inset-right));
    bottom: calc(100px + env(safe-area-inset-bottom));
  }
  .upnext-still { aspect-ratio: 16 / 9; margin-bottom: 4px; border-radius: 8px; overflow: hidden; background: rgba(255, 255, 255, 0.06); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); }
  .upnext-still img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .upnext-label { font-size: 10.5px; font-weight: 700; letter-spacing: 1.6px; text-transform: uppercase; color: rgba(255, 255, 255, 0.45); text-shadow: 0 1px 8px rgba(0, 0, 0, 0.5); }
  .upnext-title { font-size: 15px; font-weight: 650; letter-spacing: -0.2px; line-height: 1.2; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 2px 12px rgba(0, 0, 0, 0.5); }
  .upnext-ep { font-size: 13px; color: var(--pl-ink-2, rgba(255, 255, 255, 0.72)); text-shadow: 0 1px 8px rgba(0, 0, 0, 0.5); }
  .upnext-play { display: inline-flex; align-items: center; gap: 7px; align-self: flex-start; height: 38px; margin-top: 6px; padding: 0 18px; border: 0; border-radius: 999px; color: #101013; background: #fff; font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; box-shadow: 0 6px 22px rgba(0, 0, 0, 0.4); transition: transform var(--motion-fast) var(--pl-ease, cubic-bezier(0.2, 0.8, 0.2, 1)), box-shadow var(--motion-fast) var(--pl-ease, cubic-bezier(0.2, 0.8, 0.2, 1)); }
  .upnext-play:hover, .upnext-play:focus-visible { transform: scale(1.02); box-shadow: 0 8px 26px rgba(0, 0, 0, 0.5); }
  .upnext-play:active { transform: scale(.98); }
  /* Round 51 (Phase 4 — keyboard focus): the white focus ring, following the
     pill's radius (the shared player contract). */
  .upnext-play:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  @keyframes paused-card-in { from { opacity: 0; } to { opacity: 1; } }

  /* Compact portrait: the AUTO card narrows so it can never overflow a
     360px viewport; the ZONE card joins the paused zone's column stack
     (position: static, exactly the round-51 contract). */
  @media (max-width: 640px) {
    .upnext-card { width: 280px; max-width: 82vw; }
    .upnext-card:not(.auto) { position: static; }
    .upnext-card.auto { width: 248px; bottom: calc(92px + env(safe-area-inset-bottom)); }
  }
  /* Landscape phone: the compact bottom bar is shorter — the AUTO card
     anchors lower and stays clear of the timeline. */
  @media (orientation: landscape) and (max-height: 500px) {
    .upnext-card.auto { width: 248px; bottom: calc(84px + env(safe-area-inset-bottom)); }
  }

  @media (prefers-reduced-motion: reduce) {
    .upnext-card { animation: none; }
    .upnext-play { transition: none; }
  }
</style>
