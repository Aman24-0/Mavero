<script lang="ts">
  /**
   * Admin 2.0 — Phase C — AdminMediaCard
   *
   * Mobile-optimized media results. Each item renders as a stacked
   * card with the title, type, year, episode info, and per-provider
   * availability pills. Tapping a card opens the full-screen detail
   * sheet.
   *
   * See plan §26 for the responsive data-view contract.
   */
  import { Film, Tv, Sparkles, ChevronRight } from 'lucide-svelte';
  import AdminAssetStatus from './AdminAssetStatus.svelte';
  import type { LibraryMediaItem } from '$lib/server/hosting/library/service';

  let {
    items = [] as LibraryMediaItem[],
    loading = false,
    selectedId = null as string | null,
    onselect = (() => {}) as (item: LibraryMediaItem) => void,
    hostingSources = [] as Array<{ id: string; name: string; adapterId: string | null }>,
  }: {
    items?: LibraryMediaItem[];
    loading?: boolean;
    selectedId?: string | null;
    onselect?: (item: LibraryMediaItem) => void;
    hostingSources?: Array<{ id: string; name: string; adapterId: string | null }>;
  } = $props();

  function adapterIdForSource(sourceId: string | null): string | null {
    if (!sourceId) return null;
    return hostingSources.find(s => s.id === sourceId)?.adapterId ?? null;
  }
  function formatEpisode(season: number | null, episode: number | null): string {
    if (season == null && episode == null) return '';
    const s = season != null ? String(season).padStart(2, '0') : '—';
    const e = episode != null ? String(episode).padStart(2, '0') : '—';
    return `S${s}E${e}`;
  }
</script>

<div class="media-card-list" aria-label="Media library results">
  {#if loading}
    {#each Array(5) as _, i (i)}
      <div class="media-card-skeleton" aria-hidden="true"></div>
    {/each}
  {:else if items.length === 0}
    <div class="media-card-empty">
      <div class="media-empty-icon"><Film size={20} /></div>
      <div class="media-empty-title">No media</div>
      <div class="media-empty-desc">No items match the current filters.</div>
    </div>
  {:else}
    {#each items as item (item.id)}
      {@const vidaraAsset = item.assets.find(a => adapterIdForSource(a.provider_source_id) === 'vidara')}
      {@const abyssAsset = item.assets.find(a => adapterIdForSource(a.provider_source_id) === 'abyss')}
      {@const Icon = item.content_type === 'movie' ? Film : item.content_type === 'anime' ? Sparkles : Tv}
      <button
        type="button"
        class="media-card"
        class:selected={selectedId === item.id}
        onclick={() => onselect(item)}
        aria-label="Open detail for {item.title}"
      >
        <div class="media-card-head">
          <span class="type-pill type-{item.content_type}">
            <Icon size={11} />
            <span class="type-label">{item.content_type}</span>
          </span>
          {#if item.season != null || item.episode != null}
            <span class="episode-code">{formatEpisode(item.season, item.episode)}</span>
          {/if}
          <span class="year-pill">{item.year ?? '—'}</span>
          <span class="card-chevron"><ChevronRight size={16} /></span>
        </div>
        <div class="media-card-title">{item.title}</div>
        {#if item.episode_title}
          <div class="media-card-episode">{item.episode_title}</div>
        {/if}
        <div class="media-card-providers">
          <div class="provider-row">
            <span class="provider-name">Vidara</span>
            {#if vidaraAsset}
              <AdminAssetStatus status={vidaraAsset.status} maveroStatus={vidaraAsset.mavero_status} />
            {:else}
              <AdminAssetStatus status={null} maveroStatus={null} label="Not Linked" />
            {/if}
          </div>
          <div class="provider-row">
            <span class="provider-name">Abyss</span>
            {#if abyssAsset}
              <AdminAssetStatus status={abyssAsset.status} maveroStatus={abyssAsset.mavero_status} />
            {:else}
              <AdminAssetStatus status={null} maveroStatus={null} label="Not Linked" />
            {/if}
          </div>
        </div>
        {#if item.demand && item.demand.request_count > 0 && item.demand.status === 'open'}
          <div class="media-card-demand">
            Missing demand · {item.demand.request_count} requests
          </div>
        {/if}
      </button>
    {/each}
  {/if}
</div>

<style>
  .media-card-list {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-2);
    padding: var(--a2-space-2) 0;
  }

  .media-card {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-2);
    width: 100%;
    padding: var(--a2-space-3);
    border: 1px solid var(--a2-border);
    border-radius: var(--a2-radius-md);
    background: var(--a2-surface-2);
    color: inherit;
    text-align: left;
    cursor: pointer;
    transition: background var(--a2-motion-micro) var(--a2-ease-out),
                border-color var(--a2-motion-micro) var(--a2-ease-out);
    -webkit-tap-highlight-color: transparent;
  }
  .media-card:hover, .media-card:active {
    background: var(--a2-surface-3);
    border-color: var(--a2-border-strong);
  }
  .media-card.selected {
    border-color: var(--a2-cyan-border);
    background: var(--a2-cyan-soft);
  }

  .media-card-head {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
  }
  .type-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    border-radius: var(--a2-radius-xs);
    background: var(--a2-surface-3);
    color: var(--a2-text-muted);
    font-size: var(--a2-text-2xs);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .type-pill.type-movie { color: var(--a2-cyan); }
  .type-pill.type-series { color: var(--a2-blue); }
  .type-pill.type-anime { color: var(--a2-amber); }
  .type-pill .type-label { font-size: 9px; }

  .episode-code {
    color: var(--a2-text-dim);
    font-family: var(--a2-font-mono);
    font-size: 9px;
    font-weight: 600;
  }

  .year-pill {
    color: var(--a2-text-muted);
    font-family: var(--a2-font-mono);
    font-size: var(--a2-text-2xs);
  }

  .card-chevron {
    margin-left: auto;
    color: var(--a2-text-dim);
  }

  .media-card-title {
    color: var(--a2-text-bright);
    font-weight: 600;
    font-size: var(--a2-text-base);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .media-card-episode {
    color: var(--a2-text-muted);
    font-size: var(--a2-text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-top: -4px;
  }

  .media-card-providers {
    display: flex;
    flex-direction: column;
    gap: var(--a2-space-1);
    padding-top: var(--a2-space-2);
    border-top: 1px solid var(--a2-border);
  }
  .provider-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--a2-space-2);
  }
  .provider-name {
    color: var(--a2-text-muted);
    font-size: var(--a2-text-xs);
    font-weight: 600;
  }

  .media-card-demand {
    padding: var(--a2-space-1) var(--a2-space-2);
    border-radius: var(--a2-radius-xs);
    background: var(--a2-amber-soft);
    border: 1px solid var(--a2-amber-border);
    color: var(--a2-amber);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .media-card-skeleton {
    height: 110px;
    border-radius: var(--a2-radius-md);
    background: linear-gradient(90deg, var(--a2-surface-2) 0%, var(--a2-surface-3) 50%, var(--a2-surface-2) 100%);
    background-size: 200% 100%;
    animation: a2-card-skeleton 1.6s ease-in-out infinite;
  }
  @keyframes a2-card-skeleton {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  .media-card-empty {
    padding: var(--a2-space-10) var(--a2-space-4);
    text-align: center;
  }
  .media-empty-icon {
    display: inline-grid;
    place-items: center;
    width: 48px;
    height: 48px;
    margin-bottom: var(--a2-space-3);
    border-radius: var(--a2-radius-md);
    background: var(--a2-surface-3);
    color: var(--a2-text-dim);
  }
  .media-empty-title {
    font-size: var(--a2-text-sm);
    font-weight: 600;
    color: var(--a2-text);
  }
  .media-empty-desc {
    font-size: var(--a2-text-xs);
    color: var(--a2-text-dim);
    margin-top: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .media-card { transition: none; }
    .media-card-skeleton { animation: none; }
  }
</style>
