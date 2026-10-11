<script lang="ts">
  import { Clapperboard, Film, Globe, Layers, MonitorPlay, Play, Radio, SatelliteDish, Server, Tv, Video, Zap } from 'lucide-svelte';
  import { resolveSourceIcon, classifySourceIconValue, type SourceIconKey } from '$lib/shared/source-presentation';

  /**
   * Task 13: canonical SAFE source icon renderer.
   *
   * The database stores only an icon KEY. This component owns the only
   * key → component map in the codebase (the rendering-side registry that
   * pairs with the allowlist in shared/source-presentation.ts). Unknown,
   * null or tampered keys fall back to the default icon — a broken/blank
   * icon state can never render, and no SVG/HTML from the database is
   * ever executed or injected.
   *
   * MAVP-4 Issue 4: the icon value may also be a rich image — an uploaded
   * PNG data URL, a SANITIZED SVG data URL (server-side sanitizer; scripts/
   * handlers/external refs are rejected before storage) or a validated
   * http(s) image URL. Rich values render through <img>, which is
   * script-INERT by specification for SVG — untrusted markup NEVER passes
   * through {@html}. A failed/remote-broken image falls back to the default
   * key icon so the broken/blank state can still never render. Legacy keys
   * and the default fallback are byte-compatible with Task 13.
   */
  let { icon = null, size = 16 }: { icon?: string | null; size?: number } = $props();

  // All lucide-svelte icon components share one type; typing the map against
  // the default icon keeps the values structurally identical.
  const iconComponents: Record<SourceIconKey, typeof Video> = {
    video: Video,
    play: Play,
    film: Film,
    tv: Tv,
    clapperboard: Clapperboard,
    radio: Radio,
    layers: Layers,
    server: Server,
    'monitor-play': MonitorPlay,
    globe: Globe,
    'satellite-dish': SatelliteDish,
    zap: Zap,
  };

  // MAVP-4: image icons (data URL / remote URL) render via <img>; the
  // classifier is TOTAL — anything unknown/untrusted degrades to the key
  // path and then the default icon.
  const iconKind = $derived(classifySourceIconValue(icon));
  const Resolved = $derived(iconComponents[resolveSourceIcon(icon)]);
  // Remote URLs can fail after render (removed file, offline) — the failed
  // flag swaps the <img> for the default key icon (never blank).
  let imageFailed = $state(false);
  $effect(() => {
    // Reset the failure flag whenever a DIFFERENT image value arrives.
    void icon;
    imageFailed = false;
  });
</script>

{#if iconKind !== 'key' && !imageFailed}
  <img
    src={icon ?? undefined}
    width={size}
    height={size}
    alt=""
    aria-hidden="true"
    loading="lazy"
    decoding="async"
    class="source-icon-image"
    style={`width:${size}px;height:${size}px`}
    onerror={() => { imageFailed = true; }}
  />
{:else}
  <Resolved {size} aria-hidden="true" />
{/if}

<style>
  /* MAVP-4: image icons keep the exact same footprint as the lucide glyphs
     (the size prop drives the box) and stay legible on the dark surfaces. */
  .source-icon-image { display: block; object-fit: contain; border-radius: 3px; }
</style>
