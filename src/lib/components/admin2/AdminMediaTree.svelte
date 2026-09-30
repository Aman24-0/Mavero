<script lang="ts">
  /**
   * Admin 2.0 — Phase C — AdminMediaTree
   *
   * Content-tree sidebar for the Media Library. Renders the canonical
   * hierarchy (Movies by year, Series by season/episode, Anime by
   * season/episode) with counts. Clicking a node applies a filter
   * (by type, by year, or by series tmdb_id) to the main library
   * view.
   *
   * The tree data is fetched ONCE via the /api/admin/media/library/folders
   * endpoint. Expansion is client-side. The tree never loads full
   * media item lists — it only shows summaries with counts.
   *
   * Selection state: the tree highlights the active node based on
   * the current `selectedType` / `selectedYear` / `selectedSeriesTmdb`
   * props passed in by the parent.
   */
  import { ChevronDown, ChevronRight, Film, Tv, Sparkles, Hash, Library } from 'lucide-svelte';

  export type FolderSummary = {
    movies: { year: number | null; count: number }[];
    series: { tmdb_id: string; title: string; year: number | null; season_count: number; episode_count: number }[];
    anime: { tmdb_id: string; title: string; year: number | null; season_count: number; episode_count: number }[];
    totals: { movies: number; series: number; anime: number };
  };

  let {
    folders = null as FolderSummary | null,
    loading = false,
    error = null as string | null,
    selectedType = 'all' as string,
    selectedYear = null as number | null,
    selectedSeriesTmdb = null as string | null,
    onselect = (() => {}) as (selection: {
      type?: 'movie' | 'series' | 'anime' | 'all';
      year?: number | null;
      seriesTmdb?: string | null;
      label?: string;
    }) => void,
  }: {
    folders?: FolderSummary | null;
    loading?: boolean;
    error?: string | null;
    selectedType?: string;
    selectedYear?: number | null;
    selectedSeriesTmdb?: string | null;
    onselect?: (selection: {
      type?: 'movie' | 'series' | 'anime' | 'all';
      year?: number | null;
      seriesTmdb?: string | null;
      label?: string;
    }) => void;
  } = $props();

  type ExpandedState = { movies: boolean; series: boolean; anime: boolean };
  let expanded = $state<ExpandedState>({ movies: true, series: true, anime: true });

  function toggle(group: keyof ExpandedState) {
    expanded[group] = !expanded[group];
  }

  function selectAll() {
    onselect({ type: 'all', year: null, seriesTmdb: null, label: 'All Media' });
  }
  function selectMovies() {
    onselect({ type: 'movie', year: null, seriesTmdb: null, label: 'Movies' });
  }
  function selectMovieYear(year: number | null) {
    onselect({ type: 'movie', year, seriesTmdb: null, label: `Movies · ${year ?? 'Unknown Year'}` });
  }
  function selectSeries() {
    onselect({ type: 'series', year: null, seriesTmdb: null, label: 'Series' });
  }
  function selectSeriesItem(tmdb: string, title: string) {
    onselect({ type: 'series', year: null, seriesTmdb: tmdb, label: title });
  }
  function selectAnime() {
    onselect({ type: 'anime', year: null, seriesTmdb: null, label: 'Anime' });
  }
  function selectAnimeItem(tmdb: string, title: string) {
    onselect({ type: 'anime', year: null, seriesTmdb: tmdb, label: title });
  }

  function isSelected(node: { kind: string; year?: number | null; tmdb?: string | null }): boolean {
    if (node.kind === 'all') return selectedType === 'all' && selectedYear === null && selectedSeriesTmdb === null;
    if (node.kind === 'movies') return selectedType === 'movie' && selectedYear === null;
    if (node.kind === 'movie-year') return selectedType === 'movie' && selectedYear === node.year;
    if (node.kind === 'series') return selectedType === 'series' && selectedSeriesTmdb === null;
    if (node.kind === 'series-item') return selectedType === 'series' && selectedSeriesTmdb === node.tmdb;
    if (node.kind === 'anime') return selectedType === 'anime' && selectedSeriesTmdb === null;
    if (node.kind === 'anime-item') return selectedType === 'anime' && selectedSeriesTmdb === node.tmdb;
    return false;
  }
</script>

<aside class="a2-media-tree a2-scroll" aria-label="Media content tree">
  {#if loading}
    <div class="a2-tree-state">
      <div class="a2-tree-skeleton" aria-hidden="true"></div>
      <div class="a2-tree-skeleton" aria-hidden="true"></div>
      <div class="a2-tree-skeleton" aria-hidden="true"></div>
    </div>
  {:else if error}
    <div class="a2-tree-state a2-tree-state-error">
      <div class="a2-tree-state-title">Tree unavailable</div>
      <div class="a2-tree-state-desc">{error}</div>
      <div class="a2-tree-state-desc">Use search + filters instead.</div>
    </div>
  {:else if !folders}
    <div class="a2-tree-state">
      <div class="a2-tree-state-title">No media</div>
      <div class="a2-tree-state-desc">The catalog is empty. Upload media to populate the tree.</div>
    </div>
  {:else}
    <button
      type="button"
      class="tree-node tree-node-root"
      class:active={isSelected({ kind: 'all' })}
      onclick={selectAll}
      aria-current={isSelected({ kind: 'all' }) ? 'true' : undefined}
    >
      <span class="tree-icon"><Library size={14} /></span>
      <span class="tree-label">All Media</span>
      <span class="tree-count">{folders.totals.movies + folders.totals.series + folders.totals.anime}</span>
    </button>

    <!-- ============================================================
         MOVIES — grouped by year
         ============================================================ -->
    <div class="tree-group">
      <button
        type="button"
        class="tree-node tree-node-group"
        onclick={() => toggle('movies')}
        aria-expanded={expanded.movies}
      >
        <span class="tree-chevron">{#if expanded.movies}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}</span>
        <span class="tree-icon"><Film size={14} /></span>
        <span class="tree-label">Movies</span>
        <span class="tree-count">{folders.totals.movies}</span>
      </button>
      {#if expanded.movies}
        <div class="tree-children">
          <button
            type="button"
            class="tree-node tree-node-child"
            class:active={isSelected({ kind: 'movies' })}
            onclick={selectMovies}
          >
            <span class="tree-icon"><Hash size={11} /></span>
            <span class="tree-label">All Years</span>
            <span class="tree-count">{folders.totals.movies}</span>
          </button>
          {#each folders.movies as bucket}
            <button
              type="button"
              class="tree-node tree-node-child"
              class:active={isSelected({ kind: 'movie-year', year: bucket.year })}
              onclick={() => selectMovieYear(bucket.year)}
            >
              <span class="tree-icon"><Hash size={11} /></span>
              <span class="tree-label">{bucket.year ?? 'Unknown Year'}</span>
              <span class="tree-count">{bucket.count}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- ============================================================
         SERIES — listed by series (with season/episode counts)
         ============================================================ -->
    <div class="tree-group">
      <button
        type="button"
        class="tree-node tree-node-group"
        onclick={() => toggle('series')}
        aria-expanded={expanded.series}
      >
        <span class="tree-chevron">{#if expanded.series}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}</span>
        <span class="tree-icon"><Tv size={14} /></span>
        <span class="tree-label">Series</span>
        <span class="tree-count">{folders.totals.series}</span>
      </button>
      {#if expanded.series}
        <div class="tree-children">
          {#if folders.series.length === 0}
            <div class="tree-empty">No series in catalog</div>
          {:else}
            {#each folders.series as s}
              <button
                type="button"
                class="tree-node tree-node-child tree-node-series"
                class:active={isSelected({ kind: 'series-item', tmdb: s.tmdb_id })}
                onclick={() => selectSeriesItem(s.tmdb_id, s.title)}
                title={s.title}
              >
                <span class="tree-icon"><Tv size={11} /></span>
                <span class="tree-label tree-label-truncate">{s.title}</span>
                <span class="tree-count" title="{s.season_count} seasons · {s.episode_count} episodes">S{s.season_count} · E{s.episode_count}</span>
              </button>
            {/each}
          {/if}
        </div>
      {/if}
    </div>

    <!-- ============================================================
         ANIME — listed by anime (with season/episode counts)
         ============================================================ -->
    <div class="tree-group">
      <button
        type="button"
        class="tree-node tree-node-group"
        onclick={() => toggle('anime')}
        aria-expanded={expanded.anime}
      >
        <span class="tree-chevron">{#if expanded.anime}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}</span>
        <span class="tree-icon"><Sparkles size={14} /></span>
        <span class="tree-label">Anime</span>
        <span class="tree-count">{folders.totals.anime}</span>
      </button>
      {#if expanded.anime}
        <div class="tree-children">
          {#if folders.anime.length === 0}
            <div class="tree-empty">No anime in catalog</div>
          {:else}
            {#each folders.anime as s}
              <button
                type="button"
                class="tree-node tree-node-child tree-node-series"
                class:active={isSelected({ kind: 'anime-item', tmdb: s.tmdb_id })}
                onclick={() => selectAnimeItem(s.tmdb_id, s.title)}
                title={s.title}
              >
                <span class="tree-icon"><Sparkles size={11} /></span>
                <span class="tree-label tree-label-truncate">{s.title}</span>
                <span class="tree-count" title="{s.season_count} seasons · {s.episode_count} episodes">S{s.season_count} · E{s.episode_count}</span>
              </button>
            {/each}
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</aside>

<style>
  .a2-media-tree {
    width: 100%;
    height: 100%;
    overflow-y: auto;
    padding: var(--a2-space-2);
    background: var(--a2-surface-1);
    border-right: 1px solid var(--a2-border);
  }

  .a2-tree-state {
    padding: var(--a2-space-4);
    color: var(--a2-text-muted);
    font-size: var(--a2-text-sm);
  }
  .a2-tree-state-error {
    color: var(--a2-text);
  }
  .a2-tree-state-title {
    font-weight: 600;
    color: var(--a2-text);
    margin-bottom: var(--a2-space-1);
  }
  .a2-tree-state-desc {
    color: var(--a2-text-dim);
    font-size: var(--a2-text-xs);
    margin-top: var(--a2-space-1);
    line-height: 1.5;
  }

  .a2-tree-skeleton {
    height: 24px;
    margin-bottom: var(--a2-space-2);
    border-radius: var(--a2-radius-sm);
    background: linear-gradient(90deg, var(--a2-surface-2) 0%, var(--a2-surface-3) 50%, var(--a2-surface-2) 100%);
    background-size: 200% 100%;
    animation: a2-skeleton 1.6s ease-in-out infinite;
  }
  .a2-tree-skeleton:nth-child(2) { animation-delay: 0.2s; }
  .a2-tree-skeleton:nth-child(3) { animation-delay: 0.4s; }
  @keyframes a2-skeleton {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  .tree-group {
    margin-bottom: var(--a2-space-1);
  }

  .tree-node {
    display: flex;
    align-items: center;
    gap: var(--a2-space-2);
    width: 100%;
    padding: var(--a2-space-2) var(--a2-space-3);
    border: none;
    background: transparent;
    color: var(--a2-text-muted);
    text-align: left;
    cursor: pointer;
    border-radius: var(--a2-radius-sm);
    font-family: var(--a2-font-sans);
    font-size: var(--a2-text-sm);
    font-weight: 500;
    transition: background var(--a2-motion-micro) var(--a2-ease-out),
                color var(--a2-motion-micro) var(--a2-ease-out);
  }
  .tree-node:hover {
    background: var(--a2-surface-2);
    color: var(--a2-text);
  }
  .tree-node.active {
    background: var(--a2-cyan-soft);
    color: var(--a2-cyan);
  }

  .tree-node-root {
    margin-bottom: var(--a2-space-3);
    font-weight: 600;
    border: 1px solid var(--a2-border);
  }
  .tree-node-root.active {
    border-color: var(--a2-cyan-border);
  }

  .tree-node-group {
    font-weight: 600;
    color: var(--a2-text);
  }

  .tree-node-child {
    padding-left: var(--a2-space-5);
    font-size: var(--a2-text-xs);
    color: var(--a2-text-muted);
  }
  .tree-node-series {
    padding-left: var(--a2-space-5);
  }

  .tree-chevron {
    display: grid;
    place-items: center;
    width: 12px;
    color: var(--a2-text-dim);
    flex-shrink: 0;
  }

  .tree-icon {
    display: grid;
    place-items: center;
    width: 14px;
    color: inherit;
    opacity: 0.8;
    flex-shrink: 0;
  }

  .tree-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tree-label-truncate {
    text-overflow: ellipsis;
  }

  .tree-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    padding: 1px 5px;
    border-radius: var(--a2-radius-xs);
    background: var(--a2-surface-3);
    color: var(--a2-text-dim);
    font-family: var(--a2-font-mono);
    font-size: 9px;
    font-weight: 600;
    flex-shrink: 0;
  }
  .tree-node.active .tree-count {
    background: var(--a2-cyan-soft);
    color: var(--a2-cyan);
  }

  .tree-children {
    margin-top: 2px;
    margin-bottom: var(--a2-space-2);
  }

  .tree-empty {
    padding: var(--a2-space-2) var(--a2-space-5);
    color: var(--a2-text-dim);
    font-size: var(--a2-text-2xs);
    font-style: italic;
  }

  @media (prefers-reduced-motion: reduce) {
    .a2-tree-skeleton { animation: none; }
    .tree-node { transition: none; }
  }
</style>
