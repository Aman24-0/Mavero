<script lang="ts">
  import { Clapperboard, Film, Globe, Layers, MonitorPlay, Play, Radio, SatelliteDish, Server, Tv, Video, Zap } from 'lucide-svelte';
  import { resolveSourceIcon, type SourceIconKey } from '$lib/shared/source-presentation';

  /**
   * Task 13: canonical SAFE source icon renderer.
   *
   * The database stores only an icon KEY. This component owns the only
   * key → component map in the codebase (the rendering-side registry that
   * pairs with the allowlist in shared/source-presentation.ts). Unknown,
   * null or tampered keys fall back to the default icon — a broken/blank
   * icon state can never render, and no SVG/HTML from the database is
   * ever executed or injected.
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

  // Capitalized so Svelte 5 renders it as a dynamic component.
  const Resolved = $derived(iconComponents[resolveSourceIcon(icon)]);
</script>

<Resolved {size} aria-hidden="true" />
